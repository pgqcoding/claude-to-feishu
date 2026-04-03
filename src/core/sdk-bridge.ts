import type { PermissionResult, SessionInfo } from '../types.js';

/** canUseTool 回调类型（与 SDK 签名一致） */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string; agentID?: string }
) => Promise<PermissionResult>;

/** Phase 2: 流式查询选项 */
export interface StreamQueryOptions {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly onChunk?: (chunk: string) => void;
  readonly canUseTool?: CanUseToolCallback;
  readonly abortController?: AbortController;
  readonly timeoutMs?: number;
}

interface SdkQueryOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly mode?: string;
}

interface QueryResult {
  readonly text: string;
  readonly success: boolean;
  readonly error?: string;
}

/** SDK 消息事件：assistant 角色，包含多块内容 */
interface SdkMessageEvent {
  readonly type: 'assistant';
  readonly message: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  };
}

/** SDK 结果事件：包含最终文本 */
interface SdkResultEvent {
  readonly result_text: string;
}

/** SDK 原始会话记录 */
interface SdkSessionRecord {
  readonly sessionId: string;
  readonly summary?: string;
  readonly lastModified?: number | string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly customTitle?: string;
  readonly firstPrompt?: string;
}

/** 判断是否为 assistant 消息事件 */
function isSdkMessageEvent(event: unknown): event is SdkMessageEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e['type'] === 'assistant' &&
    typeof e['message'] === 'object' && e['message'] !== null &&
    Array.isArray((e['message'] as Record<string, unknown>)['content']);
}

/** 判断是否为结果事件 */
function isSdkResultEvent(event: unknown): event is SdkResultEvent {
  if (typeof event !== 'object' || event === null) return false;
  return typeof (event as Record<string, unknown>)['result_text'] === 'string';
}

/** 判断是否为 SDK 会话记录 */
function isSdkSessionRecord(s: unknown): s is SdkSessionRecord {
  if (typeof s !== 'object' || s === null) return false;
  return typeof (s as Record<string, unknown>)['sessionId'] === 'string';
}

/**
 * SDK 函数接口——依赖注入用
 * 生产环境传入真实 SDK 函数，测试时传入 mock
 */
export interface SdkFunctions {
  readonly query: (options: Record<string, unknown>) => AsyncGenerator<unknown, unknown, unknown>;
  readonly listSessions: (options: Record<string, unknown>) => Promise<unknown[]>;
}

interface BridgeConfig {
  readonly defaultModel: string;
  readonly defaultMode: string;
  readonly maxConcurrentQueries: number;
  readonly queryTimeoutMs: number;
  readonly sdk?: SdkFunctions;
}

/** 内部统一查询参数，合并 sendQuery 和 queryStream 的差异部分 */
interface InternalQueryOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly onChunk?: (chunk: string) => void;
  readonly canUseTool?: CanUseToolCallback;
  readonly timeoutMs?: number;
  /** 调用方预先创建的 AbortController，由调用方负责检查 signal 状态 */
  readonly controller: AbortController;
}

/** 可热更新的运行时参数（对应 HOT_RELOADABLE_FIELDS 中涉及 bridge 的字段） */
export interface BridgeRuntimeConfig {
  readonly defaultModel?: string;
  readonly defaultMode?: string;
  readonly maxConcurrentQueries?: number;
  readonly queryTimeoutMs?: number;
}

export class SdkBridge {
  // 使用可变引用以支持热重载，但每次更新时创建新对象（不可变更新模式）
  private config: BridgeConfig;
  private sdkFunctions: SdkFunctions | null;
  private _activeQueryCount = 0;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(config: BridgeConfig) {
    this.config = config;
    this.sdkFunctions = config.sdk ?? null;
  }

  /**
   * 热重载：以不可变更新模式替换运行时参数。
   * 正在进行中的查询继续使用旧参数，新查询使用新参数。
   */
  updateRuntimeConfig(patch: BridgeRuntimeConfig): void {
    this.config = { ...this.config, ...patch };
  }

  /** 懒加载 SDK 函数（生产环境首次调用时动态 import） */
  private async getSdk(): Promise<SdkFunctions> {
    if (this.sdkFunctions) return this.sdkFunctions;
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    // SDK 实际签名比内部接口更严格，通过 unknown 中转安全适配
    const functions: SdkFunctions = {
      query: sdk.query as unknown as SdkFunctions['query'],
      listSessions: sdk.listSessions as unknown as SdkFunctions['listSessions'],
    };
    this.sdkFunctions = functions;
    return functions;
  }

  get activeQueryCount(): number {
    return this._activeQueryCount;
  }

  async listProjectSessions(projectDir: string): Promise<SessionInfo[]> {
    const sdk = await this.getSdk();
    // 502 等临时错误重试一次
    let sdkSessions;
    try {
      sdkSessions = await sdk.listSessions({ dir: projectDir });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status && status >= 500 && status < 600) {
          await new Promise(r => setTimeout(r, 1000));
          sdkSessions = await sdk.listSessions({ dir: projectDir });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    return sdkSessions.filter(isSdkSessionRecord).map((s) => ({
      sessionId: s.sessionId,
      summary: s.summary ?? '',
      lastModified: typeof s.lastModified === 'number' ? s.lastModified : new Date(s.lastModified ?? 0).getTime(),
      cwd: s.cwd ?? projectDir,
      gitBranch: s.gitBranch,
      customTitle: s.customTitle,
      firstPrompt: s.firstPrompt,
    }));
  }

  /**
   * 统一查询执行核心：管理并发守卫、超时、generator 遍历和资源清理。
   * controller 由调用方传入，调用方可在 catch 后通过 controller.signal.aborted 判断中止状态。
   * 并发超限时直接抛出，不进入生命周期管理。
   */
  private async executeQuery(options: InternalQueryOptions): Promise<string> {
    if (this._activeQueryCount >= this.config.maxConcurrentQueries) {
      throw new Error('已达到最大并发查询数，请等待当前消息处理完成');
    }

    const { controller } = options;
    const sessionKey = options.sessionId ?? `query-${crypto.randomUUID()}`;
    this.abortControllers.set(sessionKey, controller);
    this._activeQueryCount++;

    // 超时：仅在 timeoutMs 有值时设置
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    }

    try {
      const sdk = await this.getSdk();
      const queryOptions: Record<string, unknown> = {
        prompt: options.prompt,
        options: {
          cwd: options.cwd,
          model: options.model ?? this.config.defaultModel,
          abortController: controller,
          ...(options.sessionId ? { resume: options.sessionId } : {}),
          ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
        },
      };

      const generator = sdk.query(queryOptions);
      let fullText = '';

      for await (const event of generator) {
        if (controller.signal.aborted) break;
        const text = this.extractText(event);
        if (text) {
          if (options.onChunk) {
            try {
              options.onChunk(text);
            } catch (chunkErr: unknown) {
              // onChunk 异常不应中断查询流，记录警告后继续
              console.warn('[sdk-bridge] onChunk 回调异常（已忽略）:', chunkErr);
            }
          }
          fullText += text;
        }
      }

      return fullText;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      this.abortControllers.delete(sessionKey);
      this._activeQueryCount--;
    }
  }

  async sendQuery(options: SdkQueryOptions): Promise<QueryResult> {
    const controller = new AbortController();
    try {
      const text = await this.executeQuery({
        prompt: options.prompt,
        cwd: options.cwd,
        sessionId: options.sessionId,
        model: options.model,
        timeoutMs: this.config.queryTimeoutMs,
        controller,
      });
      // break 退出循环时 signal 已中止（超时或 abortSession 触发）
      if (controller.signal.aborted) {
        return { text: '', success: false, error: '查询已中止' };
      }
      return { text, success: true };
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return { text: '', success: false, error: '查询已中止' };
      }
      const message = err instanceof Error ? err.message : '查询失败';
      return { text: '', success: false, error: message };
    }
  }

  abortSession(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  abortAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
  }

  /** Phase 2: 流式查询，支持 onChunk 回调和 canUseTool 权限拦截 */
  async queryStream(options: StreamQueryOptions): Promise<string> {
    const controller = options.abortController ?? new AbortController();
    return this.executeQuery({
      prompt: options.prompt,
      cwd: options.cwd,
      sessionId: options.sessionId,
      onChunk: options.onChunk,
      canUseTool: options.canUseTool,
      timeoutMs: options.timeoutMs ?? this.config.queryTimeoutMs,
      controller,
    });
  }

  private extractText(event: unknown): string | null {
    if (isSdkMessageEvent(event)) {
      return event.message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    }
    if (isSdkResultEvent(event)) {
      return event.result_text;
    }
    return null;
  }
}
