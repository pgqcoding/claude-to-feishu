import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitMessage, FeishuSender } from '../../src/feishu/sender.js';

describe('splitMessage', () => {
  it('does not split short messages', () => {
    const segments = splitMessage('hello');
    expect(segments).toEqual(['hello']);
  });

  it('splits long ASCII messages with page indicators', () => {
    const longText = 'a'.repeat(7601);
    const segments = splitMessage(longText);
    expect(segments.length).toBe(3);
    expect(segments[0]).toContain('[1/3]');
    expect(segments[1]).toContain('[2/3]');
    expect(segments[2]).toContain('[3/3]');
  });

  it('splits CJK text by byte count, not char count', () => {
    // 中文每字符 3 字节，1267 个中文字符 = 3801 字节 > 3800 阈值
    const cjkText = '中'.repeat(1267);
    const segments = splitMessage(cjkText);
    expect(segments.length).toBe(2);
    for (const seg of segments) {
      expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(3800 + 20);
    }
  });

  it('does not break multi-byte characters at segment boundary', () => {
    const mixed = 'a'.repeat(3700) + '中'.repeat(100);
    const segments = splitMessage(mixed);
    for (const seg of segments) {
      expect(seg).not.toContain('\uFFFD');
    }
  });
});

describe('FeishuSender', () => {
  it('tracks unreachable chats after 3 consecutive failures', async () => {
    const mockClient = {
      im: {
        message: {
          create: vi.fn().mockRejectedValue({ code: 230001, msg: 'bot_not_in_chat' }),
        },
      },
    };
    const sender = new FeishuSender(mockClient as any);
    for (let i = 0; i < 3; i++) {
      await sender.send('chat_123', { type: 'text', text: 'hi' }).catch(() => {});
    }
    expect(sender.isUnreachable('chat_123')).toBe(true);
  });

  it('限流错误码不累加失败计数，不标记不可达', async () => {
    const mockClient = {
      im: {
        message: {
          create: vi.fn().mockRejectedValue({ code: 99991400, msg: 'rate limit' }),
        },
      },
    };
    const sender = new FeishuSender(mockClient as any);
    // 即使连续触发多次限流，也不应标记为不可达
    for (let i = 0; i < 5; i++) {
      await sender.send('chat_rl', { type: 'text', text: 'hi' }).catch(() => {});
    }
    expect(sender.isUnreachable('chat_rl')).toBe(false);
  });

  it('限流错误向上抛出', async () => {
    const rateLimitErr = { code: 99991401, msg: 'rate limit exceeded' };
    const mockClient = {
      im: {
        message: {
          create: vi.fn().mockRejectedValue(rateLimitErr),
        },
      },
    };
    const sender = new FeishuSender(mockClient as any);
    await expect(sender.send('chat_rl', { type: 'text', text: 'hi' })).rejects.toEqual(rateLimitErr);
  });

  it('clears unreachable flag on clearUnreachable', () => {
    const sender = new FeishuSender({} as any);
    sender.markUnreachable('chat_123');
    expect(sender.isUnreachable('chat_123')).toBe(true);
    sender.clearUnreachable('chat_123');
    expect(sender.isUnreachable('chat_123')).toBe(false);
  });

  // --- update() 方法 ---

  it('update() 正常更新卡片消息 → 调用 patch 接口，msg_type=interactive', async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockClient = {
      im: { message: { create: vi.fn(), patch: mockPatch } },
    };
    const sender = new FeishuSender(mockClient as any);
    const card = { elements: [], header: { title: { tag: 'plain_text' as const, content: '更新内容' } } };

    await sender.update('msg_001', card);

    expect(mockPatch).toHaveBeenCalledTimes(1);
    const callArg = mockPatch.mock.calls[0][0];
    expect(callArg.path.message_id).toBe('msg_001');
    // update() 仅支持 interactive 类型（飞书 PATCH API 限制）
    expect(callArg.data.msg_type).toBe('interactive');
    expect(JSON.parse(callArg.data.content)).toEqual(card);
  });

  it('update() patch 接口抛出异常 → 向上抛出', async () => {
    const mockClient = {
      im: { message: { create: vi.fn(), patch: vi.fn().mockRejectedValue(new Error('patch failed')) } },
    };
    const sender = new FeishuSender(mockClient as any);
    const card = { elements: [], header: { title: { tag: 'plain_text' as const, content: 'hi' } } };

    await expect(sender.update('msg_001', card)).rejects.toThrow('patch failed');
  });

  // --- send() 卡片消息路径 ---

  it('send() type=card → 使用 interactive msg_type 发送', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg_card_1' } });
    const mockClient = {
      im: { message: { create: mockCreate, patch: vi.fn() } },
    };
    const sender = new FeishuSender(mockClient as any);
    const card = { elements: [], header: { title: { content: '测试卡片' } } };

    const messageId = await sender.send('chat_1', { type: 'card', card });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.data.msg_type).toBe('interactive');
    expect(JSON.parse(callArg.data.content)).toEqual(card);
    expect(messageId).toBe('msg_card_1');
  });

  it('send() type=card 且 chat 已不可达 → 抛出错误', async () => {
    const mockClient = {
      im: { message: { create: vi.fn(), patch: vi.fn() } },
    };
    const sender = new FeishuSender(mockClient as any);
    sender.markUnreachable('chat_unreachable');

    await expect(
      sender.send('chat_unreachable', { type: 'card', card: {} })
    ).rejects.toThrow('不可达');
  });
});
