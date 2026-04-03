import type { MessageSender, MessageContent, StreamState } from '../types.js';
import type { FeishuRateLimiters } from '../core/rate-limiter.js';
import { buildStreamingCard, buildCompletedCard, estimateCardSize } from './card-builder.js';

const CARD_SIZE_THRESHOLD = 20 * 1024;
const THROTTLE_INTERVAL_MS = 500;

interface StreamRendererOptions {
  readonly sender: MessageSender;
  readonly limiters: FeishuRateLimiters;
  readonly projectAlias: string;
}

/**
 * 流式渲染器
 * 1. 接收 SDK 流式 chunk，节流合并后更新飞书卡片
 * 2. 500ms 节流 + trailing update
 * 3. 多会话共享 QPS 预算（通过共享 limiters）
 * 4. 卡片 >20KB 时降级为纯文本分段
 * 5. API 429 时降级为完成后一次性发送
 */
export class StreamRenderer {
  private readonly sender: MessageSender;
  private readonly limiters: FeishuRateLimiters;
  private readonly projectAlias: string;

  private chatId: string = '';
  private messageId: string = '';
  // 使用数组替代字符串拼接，避免每次 += 创建新字符串带来的 GC 压力
  private chunks: string[] = [];
  private state: StreamState = 'idle';
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingUpdate: boolean = false;
  private lastUpdateAt: number = 0;
  private degraded: boolean = false;

  constructor(options: StreamRendererOptions) {
    this.sender = options.sender;
    this.limiters = options.limiters;
    this.projectAlias = options.projectAlias;
  }

  async start(chatId: string): Promise<void> {
    this.chatId = chatId;
    this.chunks = [];
    this.state = 'streaming';
    this.degraded = false;

    const card = buildStreamingCard({ content: '...', projectAlias: this.projectAlias });
    const content: MessageContent = { type: 'card', card };
    this.messageId = await this.sender.send(chatId, content);
    this.lastUpdateAt = Date.now();
  }

  appendChunk(chunk: string): void {
    if (this.state !== 'streaming') return;
    this.chunks.push(chunk);
    this.scheduleUpdate();
  }

  async complete(): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'degraded') return;

    this.clearThrottle();

    const content = this.chunks.join('');
    if (this.degraded) {
      await this.sendTextSegments(content);
    } else {
      const card = buildCompletedCard({
        content,
        projectAlias: this.projectAlias,
      });

      const size = estimateCardSize(card);
      if (size > CARD_SIZE_THRESHOLD) {
        await this.sendTextSegments(content);
      } else {
        await this.sender.update(this.messageId, card);
      }
    }

    this.state = 'completed';
  }

  abort(): void {
    this.clearThrottle();
    this.state = 'error';
  }

  get currentState(): StreamState {
    return this.state;
  }

  get currentContent(): string {
    return this.chunks.join('');
  }

  private scheduleUpdate(): void {
    if (this.throttleTimer !== undefined) {
      this.pendingUpdate = true;
      return;
    }

    const elapsed = Date.now() - this.lastUpdateAt;
    const delay = Math.max(0, THROTTLE_INTERVAL_MS - elapsed);

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      void this.flushUpdate();
    }, delay);
  }

  private async flushUpdate(): Promise<void> {
    if (this.state !== 'streaming') return;

    this.pendingUpdate = false;

    const card = buildStreamingCard({
      content: this.chunks.join(''),
      projectAlias: this.projectAlias,
    });
    const size = estimateCardSize(card);

    if (size > CARD_SIZE_THRESHOLD) {
      this.clearThrottle();
      this.pendingUpdate = false;
      this.degraded = true;
      this.state = 'degraded';
      return;
    }

    if (!this.limiters.messageUpdate.tryAcquire()) {
      this.clearThrottle();
      this.pendingUpdate = false;
      this.degraded = true;
      this.state = 'degraded';
      return;
    }

    try {
      await this.sender.update(this.messageId, card);
      this.lastUpdateAt = Date.now();
    } catch {
      this.degraded = true;
      this.state = 'degraded';
    }

    if (this.pendingUpdate && this.state === 'streaming') {
      this.scheduleUpdate();
    }
  }

  private async sendTextSegments(content: string): Promise<void> {
    // send 内部已经调用 splitMessage 按 UTF-8 字节分段，此处直接传整体内容，避免双重分段
    const text = `[${this.projectAlias}] ${content}`;
    await this.limiters.messageSend.waitForToken(5000);
    await this.sender.send(this.chatId, { type: 'text', text });
  }

  private clearThrottle(): void {
    if (this.throttleTimer !== undefined) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
  }
}
