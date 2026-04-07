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
  /** 新会话创建时回调，sessionId 为 SDK 分配的会话 ID */
  readonly onSessionCreated?: (sessionId: string) => void;
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

/** SDK system/init 事件：包含新建会话的 session_id */
interface SdkSystemInitEvent {
  readonly type: 'system';
  readonly subtype: 'init';
  readonly session_id: string;
}

/** 判断是否为 system/init 事件 */
function isSdkSystemInitEvent(event: unknown): event is SdkSystemInitEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e['type'] === 'system' && e['subtype'] === 'init' && typeof e['session_id'] === 'string';
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
  /** 新会话创建时回调（仅无 sessionId 时才会触发），传递 SDK 分配的 session_id */
  readonly onSessionCreated?: (sessionId: string) => void;
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

    // 收集 Claude CLI 进程的 stderr 输出，供错误诊断使用
    const stderrChunks: string[] = [];

    try {
      const sdk = await this.getSdk();
      const queryOptions: Record<string, unknown> = {
        prompt: options.prompt,
        options: {
          cwd: options.cwd,
          model: options.model ?? this.config.defaultModel,
          abortController: controller,
          // 捕获 CLI 进程 stderr，exit code 1 等错误时有助于定位原因
          stderr: (data: string) => { stderrChunks.push(data); },
          ...(options.sessionId ? { resume: options.sessionId } : {}),
          ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
        },
      };

      const generator = sdk.query(queryOptions);
      let fullText = '';
      // 标记：onSessionCreated 只触发一次（首个 system/init 事件）
      let sessionCreatedFired = false;

      try {
        for await (const event of generator) {
          if (controller.signal.aborted) break;

          // 新会话创建：从 system/init 事件提取 session_id，仅在未指定 sessionId 时回调
          if (
            !options.sessionId &&
            !sessionCreatedFired &&
            isSdkSystemInitEvent(event) &&
            options.onSessionCreated
          ) {
            sessionCreatedFired = true;
            try {
              options.onSessionCreated(event.session_id);
            } catch (cbErr: unknown) {
              // 回调异常不应中断查询流
              console.warn('[sdk-bridge] onSessionCreated 回调异常（已忽略）:', cbErr);
            }
          }

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
      } catch (iterErr: unknown) {
        // 增强错误信息：附加 CLI stderr 输出，便于排查 "process exited with code 1" 等问题
        const stderr = stderrChunks.join('').trim();
        const baseMsg = iterErr instanceof Error ? iterErr.message : String(iterErr);

        // 根据错误特征给出针对性排查建议
        let hint = '';
        if (/exited with code 1/i.test(baseMsg)) {
          if (options.sessionId) {
            hint = '（可能原因：resume 的 sessionId 不存在或已过期，尝试 /new 创建新会话）';
          } else {
            hint = '（可能原因：Claude CLI 认证失效或工作目录不存在，请检查 `claude auth status`）';
          }
        }

        const detail = stderr ? `\n[CLI stderr] ${stderr}` : '';
        throw new Error(`${baseMsg}${hint}${detail}`);
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
      onSessionCreated: options.onSessionCreated,
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
