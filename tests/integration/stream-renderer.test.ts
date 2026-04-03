import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamRenderer } from '../../src/feishu/stream-renderer.js';
import type { MessageSender } from '../../src/types.js';
import type { FeishuRateLimiters } from '../../src/core/rate-limiter.js';
import { TokenBucketLimiter } from '../../src/core/rate-limiter.js';

function createMockSender(): MessageSender & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    send: vi.fn(async (chatId, content) => {
      calls.push({ method: 'send', args: [chatId, content] });
      return 'msg_mock_id';
    }),
    update: vi.fn(async (messageId, content) => {
      calls.push({ method: 'update', args: [messageId, content] });
    }),
  };
}

function createMockLimiters(): FeishuRateLimiters {
  return {
    messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
    messageUpdate: new TokenBucketLimiter({ maxTokens: 4, refillRate: 4, name: 'update' }),
  };
}

describe('StreamRenderer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('throttled updates', () => {
    it('sends initial card on first chunk', async () => {
      const sender = createMockSender();
      const limiters = createMockLimiters();
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');
      renderer.appendChunk('Hello ');

      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it('throttles updates to 500ms interval', async () => {
      const sender = createMockSender();
      const limiters = createMockLimiters();
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');

      for (let i = 0; i < 5; i++) {
        renderer.appendChunk(`chunk${i} `);
      }

      expect(sender.update).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(500);

      expect(sender.update.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('sends trailing update on complete', async () => {
      const sender = createMockSender();
      const limiters = createMockLimiters();
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');
      renderer.appendChunk('final content');
      await renderer.complete();

      const lastUpdateCall = sender.update.mock.calls[sender.update.mock.calls.length - 1];
      expect(lastUpdateCall).toBeDefined();
    });
  });

  describe('degradation: oversized content', () => {
    it('sends text segments for content exceeding 4000 chars when degraded via rate limit', async () => {
      const sender = createMockSender();
      // update 令牌为 0，触发降级
      const limiters: FeishuRateLimiters = {
        messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
        messageUpdate: new TokenBucketLimiter({ maxTokens: 0, refillRate: 0, name: 'update-empty' }),
      };
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');

      // 超过 4000 字符，complete 后会被拆分为多段文本
      const longContent = 'a'.repeat(5000);
      renderer.appendChunk(longContent);
      await vi.advanceTimersByTimeAsync(500);
      await renderer.complete();

      // 修复双重分段后，sendTextSegments 直接调用一次 sender.send（分段由 send 内部处理）
      const textSends = sender.calls.filter(
        c => c.method === 'send' && (c.args[1] as { type: string })?.type === 'text'
      );
      expect(textSends.length).toBe(1);
      // 确认传入的文本包含 projectAlias 前缀
      const sentText = (textSends[0].args[1] as { text: string }).text;
      expect(sentText).toContain('[test]');
    });
  });

  describe('degradation: rate limit exceeded', () => {
    it('degrades to one-shot send on rate limit', async () => {
      const sender = createMockSender();
      const limiters: FeishuRateLimiters = {
        messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
        messageUpdate: new TokenBucketLimiter({ maxTokens: 0, refillRate: 0, name: 'update-empty' }),
      };
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');
      renderer.appendChunk('some content');
      await vi.advanceTimersByTimeAsync(500);

      await renderer.complete();

      expect(sender.send).toHaveBeenCalled();
    });
  });

  describe('multi-session QPS sharing', () => {
    it('shares update QPS budget across sessions', async () => {
      const sender = createMockSender();
      // update 限速 2 tokens，无自动补充
      const limiters: FeishuRateLimiters = {
        messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
        messageUpdate: new TokenBucketLimiter({ maxTokens: 2, refillRate: 0, name: 'update-limited' }),
      };

      const renderer1 = new StreamRenderer({ sender, limiters, projectAlias: 'project-a' });
      const renderer2 = new StreamRenderer({ sender, limiters, projectAlias: 'project-b' });

      await renderer1.start('chat_1');
      await renderer2.start('chat_2');

      // renderer1 消耗 1 token
      renderer1.appendChunk('chunk1 ');
      await vi.advanceTimersByTimeAsync(500);

      // renderer2 消耗 1 token（共享同一 limiter）
      renderer2.appendChunk('chunk1 ');
      await vi.advanceTimersByTimeAsync(500);

      // 两个 renderer 各消耗 1 token，共享限速器中的 2 个 token 全部耗尽
      expect(limiters.messageUpdate.availableTokens).toBeLessThanOrEqual(0);
    });
  });

  describe('cleanup', () => {
    it('clears timers on abort', async () => {
      const sender = createMockSender();
      const limiters = createMockLimiters();
      const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test' });

      await renderer.start('chat_123');
      renderer.appendChunk('content');
      renderer.abort();

      await vi.advanceTimersByTimeAsync(1000);
      const updateCountAfterAbort = sender.update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(sender.update.mock.calls.length).toBe(updateCountAfterAbort);
    });
  });
});
