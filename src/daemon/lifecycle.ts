import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { FeishuRawEvent, CardActionEvent } from '../types.js';
import { loadConfig } from '../config.js';
import { createLogger, createFileWriter } from '../utils/logger.js';
import { getDataDir, getConfigDir } from '../utils/platform.js';
import { Store } from '../core/store.js';
import { SdkBridge } from '../core/sdk-bridge.js';
import { SessionManager } from '../core/session-manager.js';
import { PermissionGateway } from '../core/permission-gateway.js';
import { FeishuSender } from '../feishu/sender.js';
import { FeishuAdapter } from '../feishu/adapter.js';
import { buildPermissionCard, buildDisabledPermissionCard } from '../feishu/card-builder.js';
import { createMessageHandler } from './handler.js';
import { createHealthServer } from './health.js';
import { checkExistingProcess, writePidFile, removePidFile, readShutdownToken } from './pid.js';
import { startConfigWatcher } from '../utils/config-watcher.js';
import { InboundRateLimiter } from '../core/rate-limiter.js';

/** 创建并启动守护进程 */
export async function createDaemon(): Promise<void> {
  // H2: 检查 Claude CLI 可用性
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    throw new Error('Claude CLI 不可用，请确认已安装并在 PATH 中');
  }

  const config = loadConfig();
  const dataDir = getDataDir();

  // H1: 日志持久化到文件
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'daemon.log');
  // 保留 fileWriter 引用，shutdown 时调用 destroy() 确保缓冲区落盘
  const fileWriter = createFileWriter(logFile);
  const logger = createLogger({
    level: config.logLevel,
    secretValues: config.secretValues,
    writer: (line) => fileWriter.write(line),
  });
  const pidPath = path.join(dataDir, 'daemon.pid');

  // PID 防重复启动
  const existing = checkExistingProcess(pidPath);
  if (existing) {
    throw new Error(`daemon 已在运行（PID: ${existing.pid}，端口: ${existing.httpPort}）`);
  }

  const store = new Store(path.join(dataDir, 'state.json'));
  const bridge = new SdkBridge({
    defaultModel: config.defaultModel,
    defaultMode: config.defaultMode,
    maxConcurrentQueries: config.maxConcurrentQueries,
    queryTimeoutMs: config.queryTimeoutMs,
  });
  const sessionManager = new SessionManager({
    store,
    bridge,
    allowedDirs: config.allowedDirs,
    dirAliases: config.dirAliases,
  });

  // H3: allowedDirs 存在性验证（warn 而非 throw，目录可能稍后创建）
  for (const dir of config.allowedDirs) {
    if (!fs.existsSync(dir)) {
      logger.warn('allowedDirs 目录不存在', { dir });
    }
  }

  // 飞书客户端（动态导入避免启动时报错）
  const lark = await import('@larksuiteoapi/node-sdk');
  const feishuClient = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: config.feishuDomain,
  });
  const sender = new FeishuSender(feishuClient);

  const permissionGateway = new PermissionGateway({
    sender,
    defaultTimeoutMs: 120_000,
    buildRequestCard: buildPermissionCard,
    buildDisabledCard: buildDisabledPermissionCard,
    permissionAllowList: config.permissionAllowList,
  });

  const handler = createMessageHandler({
    sessionManager,
    sender,
    bridge,
    config,
    store,
    logger,
    permissionGateway,
  });

  let lastMessageAt: number | null = null;

  // 入站限流器（0 表示不限流）
  const inboundRateLimiter = new InboundRateLimiter(config.inboundRateLimitPerMinute);

  const adapter = new FeishuAdapter({
    allowedUsers: [...config.allowedUsers],
    logger,
    inboundRateLimiter,
    onMessage: (msg) => {
      lastMessageAt = Date.now();
      handler(msg);
    },
    onNonTextMessage: (chatId) => {
      sender.send(chatId, { type: 'text', text: '目前仅支持文本消息' }).catch(() => {});
    },
    onMessageTooLong: (chatId) => {
      sender.send(chatId, { type: 'text', text: '消息内容过长（超过 32KB），请分段发送' }).catch(() => {});
    },
    onRateLimited: (chatId) => {
      sender.send(chatId, { type: 'text', text: '消息过于频繁，请稍后再试' }).catch(() => {});
    },
  });

  // 防重入标志，避免信号和 HTTP 端点同时触发两次 shutdown
  let isShuttingDown = false;

  // 配置热重载：稍后在启动完成后赋值
  let stopWatcher: (() => void) | null = null;

  // 优雅关闭逻辑（async，供 /shutdown 端点和信号处理共用）
  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('正在关闭...', { module: 'lifecycle' });

    // 停止配置文件监听
    stopWatcher?.();

    // 清理权限网关待处理请求并释放定时器
    permissionGateway.clearAll('进程关闭，授权已失效');
    permissionGateway.destroy();

    // 终止所有进行中的 Claude 查询
    bridge.abortAll();
    // M4: drain 等待，给进行中的流式响应一点时间写完
    await new Promise(r => setTimeout(r, 1000));

    // 等待 health server 关闭，最多 2 秒兜底
    await Promise.race([
      new Promise<void>((resolve) => {
        healthServer.close(() => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    removePidFile(pidPath);
    // 确保日志缓冲区全部落盘后再退出
    await fileWriter.destroy();
    process.exit(0);
  }

  const port = config.healthPort;

  // Health server 需要 shutdown token，token 在写 PID 文件时生成
  // 先占位，listen 回调中写 PID 后再将 token 注入（通过闭包变量）
  let shutdownToken = '';

  // Health server（含 /shutdown 端点，解决 Windows 下 SIGTERM 不可靠问题）
  const healthServer = createHealthServer({
    startTime: Date.now(),
    getActiveQueryCount: () => bridge.activeQueryCount,
    isFeishuConnected: () => adapter.isConnected,
    getLastMessageAt: () => lastMessageAt,
    // 通过闭包引用 shutdownToken，listen 之后赋值即可生效
    get shutdownToken() { return shutdownToken; },
    onShutdown: shutdown,
    diskCheckDir: dataDir,
  });

  // 限制仅本地访问，避免将运行态信息暴露到公网
  healthServer.listen(port, '127.0.0.1', () => {
    // address() 在 TCP server listen 后返回 AddressInfo 对象
    const addr = healthServer.address();
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
    // writePidFile 同时生成 shutdown token 文件，返回 token 供 health server 使用
    shutdownToken = writePidFile(pidPath, actualPort);
    logger.info(`daemon 已启动`, { port: actualPort, pid: process.pid, module: 'lifecycle' });
  });

  // 飞书 WebSocket 长连接
  const wsClient = new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: config.feishuDomain,
  });

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        // 将 SDK 回调数据包装成 FeishuRawEvent 结构后交由 adapter 处理
        adapter.handleEvent({
          header: { event_type: 'im.message.receive_v1' },
          event: data as FeishuRawEvent['event'],
        });
      },
      // C1: 处理卡片按钮点击回调（飞书要求必须返回响应，否则用户看到"操作失败"）
      'card.action.trigger': (data: unknown) => {
        const event = data as CardActionEvent;
        const { requestId, action } = event.action?.value ?? {};
        if (requestId && (action === 'allow' || action === 'deny')) {
          // 从 event.operator.open_id 提取点击者的 open_id
          const result = permissionGateway.resolvePermission(requestId, action, event.operator.open_id);
          if (result) {
            // 通过回调返回值直接更新卡片 + 弹 toast，飞书会立即刷新卡片状态
            const toastType = result.resultText === 'allowed' ? 'success' : 'warning';
            const toastContent = result.resultText === 'allowed' ? '✅ 已授权' : '❌ 已拒绝';
            return {
              toast: { type: toastType, content: toastContent },
              card: { type: 'raw', data: result.disabledCard },
            };
          }
        }
        // 无匹配请求时返回空对象
        return {};
      },
    }),
  });
  // C3: 飞书 SDK WSClient 内部自动重连，不暴露 disconnect/reconnect 回调
  // 因此初始连接状态直接标为 connected=true；若 SDK 后续暴露连接状态事件，
  // 应在此处注册回调并调用 adapter.setConnected(false/true)
  adapter.setConnected(true);

  logger.info('飞书 WebSocket 已连接', { module: 'lifecycle' });

  // H4: 接入配置热重载——监听 config.env 文件变更，热字段立即生效，冷字段提示重启
  const configPath = path.join(getConfigDir(), 'config.env');
  stopWatcher = startConfigWatcher({
    configPath,
    onHotReload: (changes) => {
      logger.info('配置热重载生效', { changes: Object.keys(changes), module: 'lifecycle' });

      // 将热字段变更映射到 bridge 运行时参数
      const patch: {
        defaultModel?: string;
        defaultMode?: string;
        maxConcurrentQueries?: number;
        queryTimeoutMs?: number;
      } = {};

      if (changes['CTF_DEFAULT_MODEL'] !== undefined) {
        patch.defaultModel = changes['CTF_DEFAULT_MODEL'];
      }
      if (changes['CTF_DEFAULT_MODE'] !== undefined) {
        patch.defaultMode = changes['CTF_DEFAULT_MODE'];
      }
      if (changes['CTF_MAX_CONCURRENT_QUERIES'] !== undefined) {
        const v = parseInt(changes['CTF_MAX_CONCURRENT_QUERIES'], 10);
        if (!isNaN(v) && v >= 1 && v <= 10) {
          patch.maxConcurrentQueries = v;
        } else {
          logger.warn('热重载：CTF_MAX_CONCURRENT_QUERIES 值无效，已忽略', {
            value: changes['CTF_MAX_CONCURRENT_QUERIES'],
            module: 'lifecycle',
          });
        }
      }
      if (changes['CTF_QUERY_TIMEOUT_MS'] !== undefined) {
        const v = parseInt(changes['CTF_QUERY_TIMEOUT_MS'], 10);
        if (!isNaN(v) && v > 0) {
          patch.queryTimeoutMs = v;
        } else {
          logger.warn('热重载：CTF_QUERY_TIMEOUT_MS 值无效，已忽略', {
            value: changes['CTF_QUERY_TIMEOUT_MS'],
            module: 'lifecycle',
          });
        }
      }

      if (Object.keys(patch).length > 0) {
        bridge.updateRuntimeConfig(patch);
      }

      // CTF_LOG_LEVEL 热更新：logger 内部级别通过 setLevel 更新
      if (changes['CTF_LOG_LEVEL'] !== undefined) {
        logger.setLevel(changes['CTF_LOG_LEVEL']);
      }
    },
    onColdChange: (fields) => {
      logger.warn('以下配置变更需重启 daemon 生效', { fields, module: 'lifecycle' });
    },
    onError: (err) => {
      logger.error('配置文件监听出错', { error: err.message, module: 'lifecycle' });
    },
  });

  // SIGTERM/SIGINT 作为降级方案（Windows 下不可靠，主路径走 POST /shutdown）
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
