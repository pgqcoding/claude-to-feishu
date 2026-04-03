// tests/unit/inbound-rate-limiter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InboundRateLimiter } from '../../src/core/rate-limiter.js';
import { FeishuAdapter } from '../../src/feishu/adapter.js';
import type { FeishuRawEvent } from '../../src/types.js';

// ===== InboundRateLimiter 单元测试 =====

describe('InboundRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maxPerMinute=0 时无限放行', () => {
    const limiter = new InboundRateLimiter(0);
    for (let i = 0; i < 1000; i++) {
      expect(limiter.tryAcquire('ou_user1')).toBe(true);
    }
  });

  it('正常放行：未超出配额的请求', () => {
    // 每分钟 5 条，burst = 5
    const limiter = new InboundRateLimiter(5);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
  });

  it('超限拒绝：用完 burst 后被拒', () => {
    const limiter = new InboundRateLimiter(3);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    // 第 4 条超限
    expect(limiter.tryAcquire('ou_user1')).toBe(false);
  });

  it('不同用户独立限流：userA 超限不影响 userB', () => {
    const limiter = new InboundRateLimiter(2);
    // 耗尽 userA 的配额
    expect(limiter.tryAcquire('ou_userA')).toBe(true);
    expect(limiter.tryAcquire('ou_userA')).toBe(true);
    expect(limiter.tryAcquire('ou_userA')).toBe(false);
    // userB 仍有独立配额
    expect(limiter.tryAcquire('ou_userB')).toBe(true);
    expect(limiter.tryAcquire('ou_userB')).toBe(true);
    expect(limiter.tryAcquire('ou_userB')).toBe(false);
  });

  it('限流恢复：等待足够时间后令牌补充', () => {
    // 每分钟 3 条，refillRate = 3/60 = 0.05 token/s，20s 补充 1 个
    const limiter = new InboundRateLimiter(3);
    limiter.tryAcquire('ou_user1');
    limiter.tryAcquire('ou_user1');
    limiter.tryAcquire('ou_user1');
    expect(limiter.tryAcquire('ou_user1')).toBe(false);

    // 推进 20 秒（补充 1 个 token）
    vi.advanceTimersByTime(20_000);
    expect(limiter.tryAcquire('ou_user1')).toBe(true);
    expect(limiter.tryAcquire('ou_user1')).toBe(false);
  });

  it('availableTokens 返回正确值', () => {
    const limiter = new InboundRateLimiter(5);
    expect(limiter.availableTokens('ou_user1')).toBe(5);
    limiter.tryAcquire('ou_user1');
    expect(limiter.availableTokens('ou_user1')).toBe(4);
  });

  it('maxPerMinute=0 时 availableTokens 返回 Infinity', () => {
    const limiter = new InboundRateLimiter(0);
    expect(limiter.availableTokens('ou_user1')).toBe(Infinity);
  });
});

// ===== FeishuAdapter + InboundRateLimiter 集成测试 =====

/** 构造最小合法的飞书文本消息事件 */
function makeTextEvent(openId: string, chatId: string, messageId: string, text: string): FeishuRawEvent {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: openId } },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  };
}

describe('FeishuAdapter 入站限流集成', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未配置 inboundRateLimiter 时所有消息正常放行', () => {
    const onMessage = vi.fn();
    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage,
    });

    for (let i = 0; i < 10; i++) {
      adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', `msg_${i}`, `hello ${i}`));
    }
    expect(onMessage).toHaveBeenCalledTimes(10);
  });

  it('超限消息触发 onRateLimited 回调而非 onMessage', () => {
    const onMessage = vi.fn();
    const onRateLimited = vi.fn();
    const limiter = new InboundRateLimiter(2);

    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage,
      onRateLimited,
      inboundRateLimiter: limiter,
    });

    // 前 2 条放行
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_1', 'hello'));
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_2', 'hello'));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onRateLimited).not.toHaveBeenCalled();

    // 第 3 条超限
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_3', 'hello'));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledWith('chat_1', 'msg_3', 'ou_user1');
  });

  it('白名单之外的用户不经过限流器（应在白名单拦截时已丢弃）', () => {
    const onMessage = vi.fn();
    const onRateLimited = vi.fn();
    const limiter = new InboundRateLimiter(1);

    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage,
      onRateLimited,
      inboundRateLimiter: limiter,
    });

    // 非白名单用户不触发任何回调
    adapter.handleEvent(makeTextEvent('ou_other', 'chat_1', 'msg_1', 'hello'));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onRateLimited).not.toHaveBeenCalled();
  });

  it('不同用户的限流相互独立', () => {
    const onMessage = vi.fn();
    const onRateLimited = vi.fn();
    const limiter = new InboundRateLimiter(1);

    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_userA', 'ou_userB'],
      onMessage,
      onRateLimited,
      inboundRateLimiter: limiter,
    });

    // userA 发 2 条：第 1 条放行，第 2 条超限
    adapter.handleEvent(makeTextEvent('ou_userA', 'chat_A', 'msg_A1', 'hi'));
    adapter.handleEvent(makeTextEvent('ou_userA', 'chat_A', 'msg_A2', 'hi'));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledTimes(1);

    // userB 有独立配额，第 1 条应放行
    adapter.handleEvent(makeTextEvent('ou_userB', 'chat_B', 'msg_B1', 'hi'));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
  });

  it('等待足够时间后限流恢复，消息再次放行', () => {
    const onMessage = vi.fn();
    const limiter = new InboundRateLimiter(3); // refillRate = 3/60 token/s

    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage,
      inboundRateLimiter: limiter,
    });

    // 耗尽 3 条配额
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_1', 'hi'));
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_2', 'hi'));
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_3', 'hi'));
    expect(onMessage).toHaveBeenCalledTimes(3);

    // 推进 20 秒补充 1 个 token（20s × 3/60 = 1 token）
    vi.advanceTimersByTime(20_000);

    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_4', 'hi'));
    expect(onMessage).toHaveBeenCalledTimes(4);
  });

  it('超限时 logger.warn 被调用', () => {
    const warn = vi.fn();
    const limiter = new InboundRateLimiter(1);

    const adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage: vi.fn(),
      inboundRateLimiter: limiter,
      logger: { warn },
    });

    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_1', 'hi'));
    adapter.handleEvent(makeTextEvent('ou_user1', 'chat_1', 'msg_2', 'hi'));
    expect(warn).toHaveBeenCalledWith(
      '入站消息超出限流，已丢弃',
      expect.objectContaining({ openId: 'ou_user1' }),
    );
  });
});
