/**
 * CLI 入口 — 跨平台 daemon 管理命令
 * shebang 由 build.mjs 在构建后插入
 *
 * 用法：
 *   claude-to-feishu init     交互式初始化配置
 *   claude-to-feishu start    启动 daemon（后台运行）
 *   claude-to-feishu stop     停止 daemon
 *   claude-to-feishu status   查看 daemon 状态
 *   claude-to-feishu restart  重启 daemon
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDataDir, getConfigDir } from './utils/platform.js';
import { checkExistingProcess, removePidFile } from './daemon/pid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = getDataDir();
const CONFIG_DIR = getConfigDir();
const PID_PATH = path.join(DATA_DIR, 'daemon.pid');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.env');

// daemon.js 与 cli.js 同目录（esbuild 构建到 dist/）
const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

const ACTIONS = ['init', 'start', 'stop', 'status', 'restart'] as const;
type Action = (typeof ACTIONS)[number];

function printUsage(): void {
  console.log(`用法：claude-to-feishu <init|start|stop|status|restart>

命令说明：
  init      交互式引导，生成 ~/.claude-to-feishu/config.env
  start     启动 daemon（后台运行）
  stop      停止 daemon
  status    查看 daemon 状态
  restart   重启 daemon`);
}

/** 等待 PID 文件出现，最多等 waitSec 秒 */
async function waitForPidFile(waitSec: number): Promise<boolean> {
  for (let i = 0; i < waitSec * 10; i++) {
    if (fs.existsSync(PID_PATH)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function startDaemon(): Promise<void> {
  // 配置文件不存在时提示用户先初始化
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[ERROR] 配置文件不存在，请先运行: claude-to-feishu init');
    process.exit(1);
  }

  const existing = checkExistingProcess(PID_PATH);
  if (existing) {
    console.log(`[INFO] daemon 已在运行 (PID: ${existing.pid}, Port: ${existing.httpPort})`);
    return;
  }

  // 清理残留 PID 文件
  if (fs.existsSync(PID_PATH)) {
    removePidFile(PID_PATH);
  }

  // 确保日志目录存在
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // 检查 daemon.js 是否存在
  if (!fs.existsSync(DAEMON_ENTRY)) {
    console.error(`[ERROR] ${DAEMON_ENTRY} 不存在，请先运行 npm run build`);
    process.exit(1);
  }

  const bootLog = path.join(LOG_DIR, 'daemon-boot.log');
  const bootErrLog = path.join(LOG_DIR, 'daemon-boot-err.log');
  const outFd = fs.openSync(bootLog, 'a');
  const errFd = fs.openSync(bootErrLog, 'a');

  // 后台启动 daemon 进程，父进程退出后子进程继续运行
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=640', '--expose-gc', DAEMON_ENTRY],
    {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env },
    },
  );
  child.unref();

  console.log(`[INFO] daemon 已启动 (PID: ${child.pid})`);

  // 等待 PID 文件生成（最多 10 秒）
  const ok = await waitForPidFile(10);
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  if (ok) {
    const content = JSON.parse(fs.readFileSync(PID_PATH, 'utf8'));
    console.log(`[INFO] Health: http://127.0.0.1:${content.httpPort}/health`);
  } else {
    console.warn('[WARN] 等待超时，PID 文件未生成。查看启动日志：');
    console.warn(`  ${bootLog}`);
    console.warn(`  ${bootErrLog}`);
  }
}

async function stopDaemon(): Promise<void> {
  const existing = checkExistingProcess(PID_PATH);
  if (!existing) {
    console.log('[INFO] daemon 未在运行');
    return;
  }

  // 尝试 HTTP shutdown
  const tokenFile = path.join(DATA_DIR, 'daemon.shutdown.token');
  let stopped = false;
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${existing.httpPort}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log('[INFO] shutdown 信号已发送');
      stopped = true;
    }
  } catch {
    // HTTP shutdown 失败，降级到 kill
  }

  if (!stopped) {
    console.log('[WARN] HTTP shutdown 失败，强制终止进程');
    try { process.kill(existing.pid, 'SIGTERM'); } catch { /* ignore */ }
  }

  // 等待进程退出（最多 10 秒）
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(existing.pid, 0); // 仅检测，不发信号
    } catch {
      break; // 进程已退出
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 强制终止 + 清理
  try { process.kill(existing.pid, 'SIGKILL'); } catch { /* ignore */ }
  removePidFile(PID_PATH);
  console.log('[INFO] daemon 已停止');
}

async function showStatus(): Promise<void> {
  const existing = checkExistingProcess(PID_PATH);
  if (!existing) {
    console.log('[INFO] daemon 未运行');
    return;
  }

  console.log(`[INFO] daemon 运行中 (PID: ${existing.pid}, Port: ${existing.httpPort})`);

  try {
    const res = await fetch(`http://127.0.0.1:${existing.httpPort}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const health = await res.json();
    console.log(JSON.stringify(health, null, 2));
  } catch {
    console.warn('[WARN] health 端点不可达');
  }
}

// ──────────────────────────────────────────────
// init 命令相关工具函数
// ──────────────────────────────────────────────

/** 普通文本输入，支持默认值 */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

/**
 * 密码输入 — 关闭终端回显，输入完成后恢复。
 * 不依赖第三方库，仅在 TTY 环境下隐藏回显；非 TTY 环境正常显示并提示注意。
 */
function promptSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    const isTTY = process.stdin.isTTY;

    if (!isTTY) {
      // 非 TTY（如管道输入）直接读一行
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    process.stdout.write(question);
    // 关闭回显
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';
    const onData = (char: string) => {
      if (char === '\r' || char === '\n') {
        // 回车确认
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '\u007f' || char === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else {
        input += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

/** 带重试的输入：校验失败时打印错误并重新提问 */
async function promptUntilValid(
  rl: readline.Interface,
  question: string,
  validate: (val: string) => string | null,
): Promise<string> {
  while (true) {
    const val = await prompt(rl, question);
    const err = validate(val);
    if (err === null) return val;
    console.error(`  [错误] ${err}`);
  }
}

/** 检查 claude CLI 是否可用 */
function checkClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 将收集到的配置序列化为 config.env 内容 */
function buildConfigEnvContent(values: {
  appId: string;
  appSecret: string;
  allowedUsers: string;
  allowedDirs: string;
  dirAliases: string;
  defaultModel: string;
}): string {
  const lines: string[] = [
    '# 由 claude-to-feishu init 生成',
    '',
    '# ── 飞书应用凭证 ──',
    `CTF_FEISHU_APP_ID=${values.appId}`,
    `CTF_FEISHU_APP_SECRET=${values.appSecret}`,
    'CTF_FEISHU_DOMAIN=https://open.feishu.cn',
    '',
    '# ── 访问控制 ──',
    `CTF_ALLOWED_USERS=${values.allowedUsers}`,
    `CTF_ALLOWED_DIRS=${values.allowedDirs}`,
  ];

  if (values.dirAliases) {
    lines.push(`CTF_DIR_ALIASES=${values.dirAliases}`);
  } else {
    lines.push('CTF_DIR_ALIASES=');
  }

  lines.push(
    '',
    '# ── Claude 配置 ──',
    `CTF_DEFAULT_MODEL=${values.defaultModel}`,
    'CTF_DEFAULT_MODE=code',
    '',
    '# ── 进程管理（可选调整）──',
    'CTF_LOG_LEVEL=info',
    'CTF_PERMISSION_ALLOW_LIST=',
    'CTF_MAX_CONCURRENT_QUERIES=3',
    'CTF_QUERY_TIMEOUT_MS=600000',
    'CTF_HEALTH_PORT=0',
    'CTF_INBOUND_RATE_LIMIT=20',
    '',
  );

  return lines.join(os.EOL);
}

/** init 命令：交互式引导用户完成首次配置 */
async function runInit(): Promise<void> {
  console.log('');
  console.log('欢迎使用 claude-to-feishu！');
  console.log('');
  console.log('开始前，请确认以下前置条件：');
  console.log('  1. Claude Code CLI 已安装（运行 claude --version 验证）');
  console.log('  2. 飞书开放平台已创建企业自建应用');
  console.log('     - 开启「机器人」能力');
  console.log('     - 获取 App ID 和 App Secret');
  console.log('     - 添加权限：im:message、im:message:send_as_bot、im:resource');
  console.log('  3. 获取你的飞书 Open ID（格式：ou_xxxxxxxx）');
  console.log('');

  // 检查 claude CLI
  const claudeOk = checkClaudeCli();
  if (!claudeOk) {
    console.warn('[警告] 未检测到 claude 命令，请确保 Claude Code CLI 已正确安装并加入 PATH。');
    console.warn('       你可以继续完成配置，稍后再安装 Claude Code CLI。');
    console.warn('');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 按 Enter 继续
  await prompt(rl, '按 Enter 继续...');
  console.log('');

  // ── 飞书应用配置 ──
  console.log('── 飞书应用配置 ──');
  const appId = await promptUntilValid(
    rl,
    '飞书 App ID (cli_ 开头): ',
    val => {
      if (!val) return 'App ID 不能为空';
      if (!val.startsWith('cli_')) return 'App ID 应以 cli_ 开头';
      return null;
    },
  );

  // 关闭 rl 后用原始模式读密码，读完再重建 rl
  rl.close();

  const appSecret = await promptSecret('飞书 App Secret (输入不回显): ');
  if (!appSecret) {
    console.error('[错误] App Secret 不能为空，请重新运行 init');
    process.exit(1);
  }

  // 重建 rl 继续剩余输入
  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('');

  // ── 访问控制 ──
  console.log('── 访问控制 ──');
  const allowedUsers = await promptUntilValid(
    rl2,
    '允许的飞书用户 Open ID (ou_ 开头，多个用分号分隔): ',
    val => {
      if (!val) return 'Open ID 不能为空';
      const ids = val.split(';').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) return 'Open ID 不能为空';
      const invalid = ids.find(id => !id.startsWith('ou_'));
      if (invalid) return `"${invalid}" 应以 ou_ 开头`;
      return null;
    },
  );

  const allowedDirs = await promptUntilValid(
    rl2,
    '允许 Claude 操作的目录 (绝对路径，多个用分号分隔): ',
    val => {
      if (!val) return '目录不能为空';
      const dirs = val.split(';').map(s => s.trim()).filter(Boolean);
      if (dirs.length === 0) return '目录不能为空';
      const invalid = dirs.find(d => !path.isAbsolute(d));
      if (invalid) return `"${invalid}" 不是绝对路径`;
      return null;
    },
  );

  const dirAliasesRaw = await prompt(
    rl2,
    '目录别名 (可选，格式 alias=path，多个用分号分隔，直接回车跳过): ',
  );

  console.log('');

  // ── Claude 配置 ──
  console.log('── Claude 配置 ──');
  const VALID_MODELS = ['sonnet', 'opus', 'haiku'];
  const defaultModel = await promptUntilValid(
    rl2,
    '默认模型 [sonnet/opus/haiku] (默认 sonnet): ',
    val => {
      if (!val) return null; // 回车默认 sonnet
      if (!VALID_MODELS.includes(val)) return `模型应为 sonnet、opus 或 haiku 之一`;
      return null;
    },
  );

  rl2.close();

  const finalModel = defaultModel || 'sonnet';

  // ── 生成配置文件 ──
  console.log('');

  // 如果配置文件已存在，询问是否覆盖
  if (fs.existsSync(CONFIG_PATH)) {
    const rl3 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await prompt(rl3, `配置文件已存在 (${CONFIG_PATH})，是否覆盖？[y/N] `);
    rl3.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('已取消，未修改配置文件。');
      return;
    }
  }

  // 确保目录存在
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const content = buildConfigEnvContent({
    appId,
    appSecret,
    allowedUsers,
    allowedDirs,
    dirAliases: dirAliasesRaw,
    defaultModel: finalModel,
  });

  fs.writeFileSync(CONFIG_PATH, content, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('配置完成！');
  console.log(`配置文件已写入：${CONFIG_PATH}`);
  console.log('');
  console.log('下一步：运行 claude-to-feishu start 启动 daemon');
  console.log('');
}

// --- main ---
const action = process.argv[2] as Action | undefined;

if (!action || !ACTIONS.includes(action)) {
  printUsage();
  process.exit(action ? 1 : 0);
}

switch (action) {
  case 'init':
    await runInit();
    break;
  case 'start':
    await startDaemon();
    break;
  case 'stop':
    await stopDaemon();
    break;
  case 'status':
    await showStatus();
    break;
  case 'restart':
    await stopDaemon();
    await startDaemon();
    break;
}
