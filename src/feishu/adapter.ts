import type { FeishuRawEvent, IncomingMessage } from '../types.js';
import { isFeishuRawEvent } from '../types.js';
import { InboundRateLimiter } from '../core/rate-limiter.js';

interface AdapterConfig {
  readonly allowedUsers: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
  readonly onNonTextMessage?: (chatId: string, messageId: string) => void;
  readonly onMessageTooLong?: (chatId: string, messageId: string) => void;
  /** 超限时的回调，用于向用户发送友好提示 */
  readonly onRateLimited?: (chatId: string, messageId: string, openId: string) => void;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** 入站限流器，未传则不限流 */
  readonly inboundRateLimiter?: InboundRateLimiter;
}

const DEDUP_MAX_SIZE = 1000;

/** 消息内容最大长度（32KB），防止超大文本消耗 Claude API 额度 */
const MAX_TEXT_LENGTH = 32768;

export class FeishuAdapter {
  private readonly config: AdapterConfig;
  private readonly seenMessageIds = new Set<string>();
  private connected = false;
  /** 重连去重窗口定时器句柄，用于 destroy 时清理 */
  private reconnectDedupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  /** 处理飞书事件（由 WSClient 或测试调用） */
  handleEvent(data: unknown): void {
    // 系统边界：验证入参结构，非预期数据直接丢弃
    if (!isFeishuRawEvent(data)) {
      return;
    }
    const eventType = data.header?.event_type;
    if (eventType !== 'im.message.receive_v1') return;

    const event = data.event;
    const sender = event?.sender?.sender_id?.open_id;
    const message = event?.message;

    if (!sender || !message) return;

    const messageId = message.message_id;
    // messageId 为空则无法去重，直接跳过
    if (!messageId) return;

    // chat_id 缺失无法路由消息，直接跳过
    const chatId = message.chat_id;
    if (!chatId) return;

    // 去重
    if (this.seenMessageIds.has(messageId)) return;
    this.addToDedup(messageId);

    // 白名单校验
    if (!this.config.allowedUsers.includes(sender)) return;

    // 入站限流：白名单用户通过后再检查频率
    if (this.config.inboundRateLimiter && !this.config.inboundRateLimiter.tryAcquire(sender)) {
      this.config.logger?.warn('入站消息超出限流，已丢弃', {
        module: 'adapter',
        openId: sender,
        chatId,
        messageId,
      });
      this.config.onRateLimited?.(chatId, messageId, sender);
      return;
    }

    // 群聊过滤（MVP 仅私聊）
    const chatType = message.chat_type;
    if (chatType && chatType !== 'p2p') return;

    // 消息类型过滤
    if (message.message_type !== 'text') {
      this.config.onNonTextMessage?.(chatId, messageId);
      return;
    }

    // 解析消息内容
    let text: string;
    try {
      const content = JSON.parse(message.content ?? '');
      text = content.text ?? '';
    } catch {
      return;
    }

    // 长度限制：超过 32KB 的消息直接丢弃，防止恶意文本消耗 Claude API 额度
    if (text.length > MAX_TEXT_LENGTH) {
      this.config.logger?.warn('消息超过最大长度限制，已丢弃', {
        module: 'adapter',
        chatId,
        messageId,
        length: text.length,
        limit: MAX_TEXT_LENGTH,
      });
      this.config.onMessageTooLong?.(chatId, messageId);
      return;
    }

    this.config.onMessage({
      openId: sender,
      chatId,
      messageId,
      text,
    });
  }

  private addToDedup(messageId: string): void {
    this.seenMessageIds.add(messageId);
    // FIFO 淘汰
    if (this.seenMessageIds.size > DEDUP_MAX_SIZE) {
      const first = this.seenMessageIds.values().next().value;
      if (first !== undefined) {
        this.seenMessageIds.delete(first);
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  setConnected(value: boolean): void {
    this.connected = value;
  }

  /** 重连后启用去重窗口（30 秒后清空）；多次调用会取消旧定时器，防止累积 */
  enableReconnectDedup(): void {
    clearTimeout(this.reconnectDedupTimer);
    this.reconnectDedupTimer = setTimeout(() => {
      this.seenMessageIds.clear();
      this.reconnectDedupTimer = undefined;
    }, 30_000);
  }

  /** 销毁实例，清理所有定时器 */
  destroy(): void {
    clearTimeout(this.reconnectDedupTimer);
    this.reconnectDedupTimer = undefined;
  }
}
