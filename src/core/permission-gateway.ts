import { randomUUID, createHash } from 'node:crypto';
import type { MessageSender, PermissionResult, PermissionRequest, FeishuCardContent } from '../types.js';

// 卡片构建参数类型（与 card-builder 保持一致，不 import feishu 层）
interface BuildRequestCardParams {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly requestId: string;
  readonly projectAlias: string;
}

interface BuildDisabledCardParams {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly result: 'allowed' | 'denied' | 'timeout';
  readonly projectAlias: string;
}

/** 白名单条目：精确工具名或带通配符的工具名+参数模式 */
type PermissionPattern = string;

/** 解析通配符模式，格式如 "Bash(npm *)"、"Bash(*)"、"Read"
 *  返回 { toolName, argPattern }，无括号时 argPattern 为空字符串（匹配任意参数） */
function parsePattern(pattern: string): { toolName: string; argPattern: string } {
  const match = pattern.match(/^(\w+)\((.*)\)$/);
  if (match) {
    return { toolName: match[1], argPattern: match[2] };
  }
  return { toolName: pattern, argPattern: '' };
}

/** 检查工具调用是否匹配白名单模式
 *  支持：Read（精确）、Bash(*)、Bash(npm *)、Bash(npm install *) 等 */
function matchesPattern(toolName: string, toolInput: Record<string, unknown>, pattern: PermissionPattern): boolean {
  const { toolName: patTool, argPattern } = parsePattern(pattern);

  if (toolName !== patTool) return false;

  // 无参数模式（纯工具名），直接匹配
  if (!argPattern) return true;

  // 有参数模式：取第一个字符串参数进行匹配
  const firstArg = extractFirstStringArg(toolInput);
  if (firstArg === null) return false;
  return globMatch(firstArg, argPattern);
}

/** 提取 toolInput 中第一个字符串类型的参数值 */
function extractFirstStringArg(toolInput: Record<string, unknown>): string | null {
  for (const val of Object.values(toolInput)) {
    if (typeof val === 'string') return val;
  }
  return null;
}

/** 简化版 glob 匹配：支持 * 匹配任意字符（不含空格）、** 匹配任意字符（含空格） */
function globMatch(text: string, pattern: string): boolean {
  // 将 glob 转为正则：* → [^ ]*（不含空格段）、** → .*（含空格段）
  const regex = pattern
    .replace(/\*\*/g, '⟨DOTSTAR⟩')
    .replace(/\*/g, '⟨NONSPC⟩')
    .replace(/⟨DOTSTAR⟩/g, '.*')
    .replace(/⟨NONSPC⟩/g, '[^ ]*')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // 转义正则特殊字符

  try {
    return new RegExp(`^${regex}$`).test(text);
  } catch {
    return false;
  }
}

interface PermissionGatewayOptions {
  readonly permissionAllowList?: readonly PermissionPattern[];

  readonly sender: MessageSender;
  readonly defaultTimeoutMs: number;
  /** 构建权限请求卡片（注入，避免 core 层依赖 feishu 层） */
  readonly buildRequestCard: (params: BuildRequestCardParams) => FeishuCardContent;
  /** 构建已禁用卡片（注入，避免 core 层依赖 feishu 层） */
  readonly buildDisabledCard: (params: BuildDisabledCardParams) => FeishuCardContent;
}

interface RequestPermissionParams {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly chatId: string;
  readonly userOpenId: string;
  readonly projectAlias: string;
}

interface PendingRequest {
  readonly request: PermissionRequest;
  readonly resolve: (result: PermissionResult) => void;
  readonly timeoutTimer: ReturnType<typeof setTimeout>;
  readonly projectAlias: string;
}

interface ToolDecisionRecord {
  readonly action: 'allowed' | 'denied' | 'timeout';
  readonly count: number;
  readonly sessionId: string;
  readonly timestamp: number;
}

/**
 * 工具授权网关
 * 1. 发送授权卡片（允许/拒绝按钮）
 * 2. 等待用户点击或超时
 * 3. UUID v4 一次性 token 防重放
 * 4. 校验点击者 open_id
 * 5. 已响应卡片更新为不可点击
 * 6. 120s 超时自动拒绝
 * 7. 进程重启后通知用户授权失效
 * 8. 支持 /approve 文本命令备选
 */
export class PermissionGateway {
  private readonly sender: MessageSender;
  private readonly defaultTimeoutMs: number;
  private readonly buildRequestCard: (params: BuildRequestCardParams) => FeishuCardContent;
  private readonly buildDisabledCard: (params: BuildDisabledCardParams) => FeishuCardContent;
  private readonly permissionAllowList: readonly PermissionPattern[];
  // usedTokens 上限，Bot 场景并发量低，1000 条足够
  private static readonly MAX_USED_TOKENS = 1_000;
  // 清理间隔缩短为 10 分钟，避免长时间积压
  private static readonly CLEANUP_INTERVAL_MS = 10 * 60_000;
  // Bot 场景 token 生命周期短，30 分钟足够
  private static readonly TOKEN_TTL_MS = 30 * 60_000;
  // 超时重试上限
  private static readonly MAX_TIMEOUT_RETRIES = 2;

  private readonly pendingRequests: Map<string, PendingRequest> = new Map();
  private readonly usedTokens: Map<string, number> = new Map();
  // 去重记录：key = hash(toolName + toolInput)，防止拒绝/超时后反复发送授权卡片
  private readonly deniedTools: Map<string, ToolDecisionRecord> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PermissionGatewayOptions) {
    this.sender = options.sender;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.buildRequestCard = options.buildRequestCard;
    this.buildDisabledCard = options.buildDisabledCard;
    this.permissionAllowList = options.permissionAllowList ?? [];
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredTokens(),
      PermissionGateway.CLEANUP_INTERVAL_MS,
    );
  }

  private cleanupExpiredTokens(): void {
    const cutoff = Date.now() - PermissionGateway.TOKEN_TTL_MS;
    for (const [id, ts] of this.usedTokens) {
      if (ts < cutoff) this.usedTokens.delete(id);
    }
    // 同时清理超过 1 小时的去重记录
    for (const [key, record] of this.deniedTools) {
      if (record.timestamp < cutoff) this.deniedTools.delete(key);
    }
  }

  /** 生成去重 key（toolName + toolInput 的 sha256 哈希） */
  private getDedupKey(toolName: string, toolInput: Record<string, unknown>): string {
    const content = `${toolName}:${JSON.stringify(toolInput)}`;
    return createHash('sha256').update(content).digest('hex');
  }

  /** 记录已使用的 token，超过上限时淘汰最旧条目 */
  private markTokenUsed(requestId: string): void {
    if (this.usedTokens.size >= PermissionGateway.MAX_USED_TOKENS) {
      // Map 保持插入顺序，删除最旧的一条
      const oldestKey = this.usedTokens.keys().next().value;
      if (oldestKey !== undefined) this.usedTokens.delete(oldestKey);
    }
    this.usedTokens.set(requestId, Date.now());
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  requestPermission(params: RequestPermissionParams): Promise<PermissionResult> {
    // 白名单检查：支持精确工具名和 Bash(npm *) 等参数模式
    if (this.permissionAllowList.some(p => matchesPattern(params.toolName, params.toolInput, p))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: null });
    }

    // 去重检查：已处理过的工具调用不再发送授权卡片
    const dedupKey = this.getDedupKey(params.toolName, params.toolInput);
    const record = this.deniedTools.get(dedupKey);

    if (record && record.sessionId === params.chatId) {
      // 已允许：同一对话中直接放行
      if (record.action === 'allowed') {
        return Promise.resolve({ behavior: 'allow', updatedInput: null });
      }
      // 已拒绝：同一对话中直接返回拒绝
      if (record.action === 'denied') {
        return Promise.resolve({
          behavior: 'deny',
          message: '该工具调用已被拒绝（本次对话）',
        });
      }
      // 超时：超过重试上限后不再发送
      if (record.action === 'timeout' && record.count >= PermissionGateway.MAX_TIMEOUT_RETRIES) {
        return Promise.resolve({
          behavior: 'deny',
          message: `该工具调用已超时 ${record.count} 次，不再重试`,
        });
      }
    }

    const requestId = randomUUID();
    const request: PermissionRequest = {
      requestId,
      toolName: params.toolName,
      toolInput: params.toolInput,
      toolUseID: params.toolUseID,
      chatId: params.chatId,
      userOpenId: params.userOpenId,
      createdAt: Date.now(),
      timeoutMs: this.defaultTimeoutMs,
    };

    const card = this.buildRequestCard({
      toolName: params.toolName,
      toolInput: params.toolInput,
      requestId,
      projectAlias: params.projectAlias,
    });

    // 同步注册 pending，确保 resolvePermission 可立即找到
    return new Promise<PermissionResult>((resolve) => {
      const timeoutTimer = setTimeout(() => {
        this.handleTimeout(requestId, params.toolName, params.projectAlias);
      }, this.defaultTimeoutMs);

      // 直接写入 Map，不经过中间对象
      this.pendingRequests.set(requestId, { request, resolve, timeoutTimer, projectAlias: params.projectAlias });

      // 异步发送卡片，完成后通过不可变更新将 messageId 写回 Map
      this.sender.send(params.chatId, { type: 'card', card }).then((messageId) => {
        const existing = this.pendingRequests.get(requestId);
        if (existing) {
          this.pendingRequests.set(requestId, {
            ...existing,
            request: { ...existing.request, messageId },
          });
        }
      }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        // 卡片发送失败时记录错误到 stderr，便于排查
        console.error(`[permission-gateway] 授权卡片发送失败: ${errMsg}`);
        // 尝试发送文本兜底，告知用户可用 /approve 手动授权
        this.sender.send(params.chatId, {
          type: 'text',
          text: `⚠️ 授权卡片发送失败，但请求仍在等待中。\n` +
                `请回复 /approve 手动批准工具调用: ${params.toolName}\n` +
                `或等待 ${Math.floor(this.defaultTimeoutMs / 1000)}s 后自动拒绝`,
        }).catch(() => {});
        // 不立即拒绝——保留 pending，等待用户 /approve 或超时
      });
    });
  }

  /** 解析权限请求，返回禁用卡片数据（供回调直接返回给飞书更新卡片），失败返回 null */
  resolvePermission(requestId: string, action: 'allow' | 'deny', clickerOpenId: string): {
    readonly disabledCard: FeishuCardContent;
    readonly resultText: 'allowed' | 'denied';
  } | null {
    // 防重放：已使用的 token 直接拒绝
    if (this.usedTokens.has(requestId)) {
      console.error(`[permission-gateway] 重复 token，已忽略: ${requestId.slice(0, 8)}`);
      return null;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      console.error(`[permission-gateway] 未找到 pending 请求: ${requestId.slice(0, 8)}`);
      return null;
    }

    // 校验点击者身份
    if (pending.request.userOpenId !== clickerOpenId) {
      console.error(
        `[permission-gateway] 身份校验失败:\n` +
        `  期望的 userOpenId: ${pending.request.userOpenId}\n` +
        `  实际的 clickerOpenId: ${clickerOpenId}\n` +
        `  requestId: ${requestId.slice(0, 8)}`,
      );
      return null;
    }

    this.markTokenUsed(requestId);
    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timeoutTimer);

    const resultText = action === 'allow' ? 'allowed' : 'denied';
    const disabledCard = this.buildDisabledCard({
      toolName: pending.request.toolName,
      toolInput: pending.request.toolInput,
      result: resultText,
      projectAlias: pending.projectAlias,
    });

    // 更新卡片为不可点击状态
    if (pending.request.messageId) {
      this.sender.update(pending.request.messageId, disabledCard).catch(() => {});
    }

    if (action === 'allow') {
      // 记录允许，同一对话中相同工具调用直接放行
      const dedupKey = this.getDedupKey(pending.request.toolName, pending.request.toolInput);
      this.deniedTools.set(dedupKey, {
        action: 'allowed',
        count: 1,
        sessionId: pending.request.chatId,
        timestamp: Date.now(),
      });
      pending.resolve({ behavior: 'allow', updatedInput: null });
    } else {
      // 记录拒绝，同一对话中不再发送相同授权卡片
      const dedupKey = this.getDedupKey(pending.request.toolName, pending.request.toolInput);
      this.deniedTools.set(dedupKey, {
        action: 'denied',
        count: 1,
        sessionId: pending.request.chatId,
        timestamp: Date.now(),
      });
      pending.resolve({ behavior: 'deny', message: '用户拒绝了工具调用' });
    }

    return { disabledCard, resultText };
  }

  /** 通过文本命令 /approve 批准最新待处理请求 */
  approveByTextCommand(userOpenId: string, chatId: string): boolean {
    let latestPending: { requestId: string; pending: PendingRequest } | undefined;

    for (const [requestId, pending] of this.pendingRequests) {
      if (
        pending.request.userOpenId === userOpenId &&
        pending.request.chatId === chatId
      ) {
        if (!latestPending || pending.request.createdAt > latestPending.pending.request.createdAt) {
          latestPending = { requestId, pending };
        }
      }
    }

    if (!latestPending) return false;
    return this.resolvePermission(latestPending.requestId, 'allow', userOpenId) !== null;
  }

  /** 清除所有待处理请求（进程重启时调用） */
  clearAll(reason: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutTimer);
      this.markTokenUsed(requestId);
      pending.resolve({ behavior: 'deny', message: reason });
    }
    this.pendingRequests.clear();
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  private handleTimeout(requestId: string, toolName: string, projectAlias: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.markTokenUsed(requestId);
    this.pendingRequests.delete(requestId);

    // 记录超时，累计次数
    const dedupKey = this.getDedupKey(toolName, pending.request.toolInput);
    const existing = this.deniedTools.get(dedupKey);
    const newCount = existing?.action === 'timeout' ? existing.count + 1 : 1;
    this.deniedTools.set(dedupKey, {
      action: 'timeout',
      count: newCount,
      sessionId: pending.request.chatId,
      timestamp: Date.now(),
    });

    // 从 Map 中读取 messageId，不依赖闭包参数
    const messageId = pending.request.messageId;
    if (messageId) {
      const disabledCard = this.buildDisabledCard({ toolName, toolInput: pending.request.toolInput, result: 'timeout', projectAlias });
      this.sender.update(messageId, disabledCard).catch(() => {});
    }

    pending.resolve({ behavior: 'deny', message: '工具授权超时（120s），自动拒绝' });
  }

  /** 清空去重记录（新 session 开始时调用） */
  clearDeniedRecords(sessionId?: string): void {
    if (sessionId) {
      for (const [key, record] of this.deniedTools) {
        if (record.sessionId === sessionId) {
          this.deniedTools.delete(key);
        }
      }
    } else {
      this.deniedTools.clear();
    }
  }
}
