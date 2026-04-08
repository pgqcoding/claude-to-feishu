// 全局内部类型，不导出 SDK 类型

/** 消息内容联合类型 */
export type MessageContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'card'; readonly card: FeishuCardContent };

/** 飞书卡片类型别名，保留向后兼容 */
export type FeishuCard = FeishuCardContent;

/** 内部会话信息（从 SDK 类型转换而来） */
export interface SessionInfo {
  readonly sessionId: string;
  readonly summary: string;
  readonly lastModified: number;
  readonly cwd: string;
  readonly gitBranch?: string;
  readonly customTitle?: string;
  readonly firstPrompt?: string;
}

/** 会话绑定状态 */
export interface SessionBinding {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly projectAlias: string;
  readonly boundAt: number;
}

/** 支持的模型名称 */
export type ModelName = 'sonnet' | 'opus' | 'haiku';

/** 支持的模型列表 */
export const SUPPORTED_MODELS: readonly ModelName[] = ['sonnet', 'opus', 'haiku'] as const;

/** 类型守卫：判断字符串是否为有效模型名称 */
export function isValidModel(name: string): name is ModelName {
  return SUPPORTED_MODELS.includes(name as ModelName);
}

/** 应用持久化状态 */
export interface AppState {
  readonly version: number;
  readonly currentBinding: SessionBinding | null;
  // 保留最近访问的 sessionId 列表，用于快速切换
  readonly recentSessionIds: readonly string[];
  // 运行时活跃模型，未设置时降级到 config.defaultModel
  readonly activeModel?: string;
}

/** 健康检查响应，对外 HTTP API 响应，使用 snake_case 风格 */
export interface HealthResponse {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly uptime_s: number;
  readonly active_queries: number;
  readonly feishu_connected: boolean;
  readonly last_message_at: number | null;
  readonly memory_mb: number;
  readonly disk_free_mb?: number;
}

/** 命令解析结果 */
export type CommandResult =
  | { readonly type: 'command'; readonly name: string; readonly args: string }
  | { readonly type: 'message'; readonly text: string };

/** 查询状态 */
export type QueryStatus = 'idle' | 'queued' | 'running' | 'waiting_auth';

/** 消息发送器接口 */
export interface MessageSender {
  send(chatId: string, content: MessageContent): Promise<string>;
  // 飞书 PATCH API 仅支持 interactive 类型，故只接受卡片内容
  update(messageId: string, card: FeishuCardContent): Promise<void>;
}

// ===== Phase 2 类型 =====

/** 飞书消息卡片完整结构，兼容 FeishuCard index signature */
export interface FeishuCardContent {
  readonly [key: string]: unknown;
  readonly config?: { readonly wide_screen_mode?: boolean };
  readonly header?: {
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
    readonly template?: string;
  };
  readonly elements: readonly FeishuCardElement[];
}

/** 卡片元素联合类型 */
export type FeishuCardElement =
  | FeishuMarkdownElement
  | FeishuButtonGroupElement
  | FeishuDividerElement
  | FeishuNoteElement;

export interface FeishuMarkdownElement {
  readonly tag: 'markdown';
  readonly content: string;
}

export interface FeishuButtonGroupElement {
  readonly tag: 'action';
  readonly actions: readonly FeishuButton[];
}

export interface FeishuButton {
  readonly tag: 'button';
  readonly text: { readonly tag: 'plain_text'; readonly content: string };
  readonly type: 'primary' | 'danger' | 'default';
  readonly value: Record<string, string>;
}

export interface FeishuDividerElement {
  readonly tag: 'hr';
}

export interface FeishuNoteElement {
  readonly tag: 'note';
  readonly elements: readonly { readonly tag: 'plain_text'; readonly content: string }[];
}

/** 工具授权请求 */
export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly chatId: string;
  readonly userOpenId: string;
  readonly messageId?: string;
  readonly createdAt: number;
  readonly timeoutMs: number;
}

/** 工具授权结果 */
export type PermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

/** 流式渲染状态 */
export type StreamState = 'idle' | 'streaming' | 'completed' | 'error' | 'degraded';

/** 流式渲染会话 */
export interface StreamSession {
  readonly sessionId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly state: StreamState;
  readonly contentBuffer: string;
  readonly lastUpdateAt: number;
}

/** 速率限制器配置 */
export interface RateLimiterConfig {
  readonly maxTokens: number;
  readonly refillRate: number;
  readonly name: string;
}

// ===== 飞书原始事件类型 =====

/** 飞书 WebSocket 原始事件结构（最小契约，仅包含本项目关心的字段） */
export interface FeishuRawEvent {
  readonly header?: { readonly event_type?: string };
  readonly event?: {
    readonly sender?: { readonly sender_id?: { readonly open_id?: string } };
    readonly message?: {
      readonly message_id?: string;
      readonly chat_id?: string;
      readonly chat_type?: string;
      readonly message_type?: string;
      readonly content?: string;
    };
  };
}

/** 类型守卫：判断 unknown 值是否为 FeishuRawEvent 基本结构
 *  要求 header 为对象且 header.event_type 为字符串（非空校验由调用方负责）
 */
export function isFeishuRawEvent(value: unknown): value is FeishuRawEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const header = v['header'];
  if (typeof header !== 'object' || header === null) return false;
  return typeof (header as Record<string, unknown>)['event_type'] === 'string';
}

/** 卡片回调事件（飞书 card.action.trigger） */
export interface CardActionEvent {
  readonly schema?: string;
  readonly event_id?: string;
  readonly token: string;
  readonly create_time?: string;
  readonly event_type?: string;
  readonly tenant_key?: string;
  readonly app_id?: string;
  readonly operator: {
    readonly tenant_key: string;
    readonly open_id: string;
    readonly union_id: string;
    readonly user_id?: string;
  };
  readonly action: {
    readonly value: Record<string, string>;
    readonly tag: string;
    readonly option?: string;
    readonly timezone?: string;
  };
  readonly host?: string;
  readonly context?: {
    readonly open_message_id: string;
    readonly open_chat_id: string;
  };
  readonly open_message_id: string;  // 保留顶层字段以兼容旧代码
}

/** 来自飞书的入站消息（adapter 和 handler 共用） */
export interface IncomingMessage {
  readonly openId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
}
