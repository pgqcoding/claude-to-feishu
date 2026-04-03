import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuAdapter } from '../../src/feishu/adapter.js';

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;
  let mockHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockHandler = vi.fn();
    adapter = new FeishuAdapter({
      allowedUsers: ['ou_user1'],
      onMessage: mockHandler,
    });
  });

  describe('message filtering', () => {
    it('ignores messages from non-whitelisted users', () => {
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_stranger' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg1', chat_id: 'chat1' },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('processes messages from whitelisted users', () => {
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hello"}', message_id: 'msg1', chat_id: 'chat1' },
        },
      });
      expect(mockHandler).toHaveBeenCalledWith({
        openId: 'ou_user1',
        chatId: 'chat1',
        messageId: 'msg1',
        text: 'hello',
      });
    });

    it('rejects non-text messages with callback', () => {
      const mockReject = vi.fn();
      adapter = new FeishuAdapter({
        allowedUsers: ['ou_user1'],
        onMessage: mockHandler,
        onNonTextMessage: mockReject,
      });
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'image', content: '{}', message_id: 'msg2', chat_id: 'chat1' },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
      expect(mockReject).toHaveBeenCalledWith('chat1', 'msg2');
    });
  });

  describe('deduplication', () => {
    it('deduplicates messages with same message_id', () => {
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg-dup', chat_id: 'chat1' },
        },
      };
      adapter.handleEvent(event);
      adapter.handleEvent(event);
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('input validation guard', () => {
    it('ignores null input', () => {
      adapter.handleEvent(null);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('ignores non-object input', () => {
      adapter.handleEvent('invalid');
      adapter.handleEvent(42);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('ignores event with missing message_id', () => {
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', chat_id: 'chat1' },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('message length limit', () => {
    it('丢弃超过 32KB 的消息，不触发 onMessage', () => {
      // 生成 32769 字符的文本（超过 32768 限制）
      const longText = 'a'.repeat(32769);
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: longText }),
            message_id: 'msg-toolong',
            chat_id: 'chat1',
          },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('超长消息触发 onMessageTooLong 回调', () => {
      const mockTooLong = vi.fn();
      const adapterWithCallback = new FeishuAdapter({
        allowedUsers: ['ou_user1'],
        onMessage: mockHandler,
        onMessageTooLong: mockTooLong,
      });
      const longText = 'a'.repeat(32769);
      adapterWithCallback.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: longText }),
            message_id: 'msg-toolong2',
            chat_id: 'chat1',
          },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
      expect(mockTooLong).toHaveBeenCalledWith('chat1', 'msg-toolong2');
    });

    it('正好 32768 字符的消息可以通过', () => {
      const maxText = 'a'.repeat(32768);
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: maxText }),
            message_id: 'msg-maxlen',
            chat_id: 'chat1',
          },
        },
      });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('enableReconnectDedup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('多次调用不会累积多个定时器，只保留最新一个', () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      // 第一次调用
      adapter.enableReconnectDedup();
      // 第二次调用应先 clearTimeout 旧定时器
      adapter.enableReconnectDedup();
      // 第三次调用同理
      adapter.enableReconnectDedup();

      // 每次调用都会 clearTimeout（第一次传入 undefined 也不影响）
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(3);
      // 只有 3 个 setTimeout 被创建（非 6 个）
      const dedupCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000);
      expect(dedupCalls).toHaveLength(3);

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      adapter.destroy();
    });

    it('30 秒后清空 seenMessageIds', async () => {
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg-dedup', chat_id: 'chat1' },
        },
      };
      // 消费一次，加入去重表
      adapter.handleEvent(event);
      expect(mockHandler).toHaveBeenCalledTimes(1);

      // 重连，启动去重窗口
      adapter.enableReconnectDedup();
      // 同一条消息在窗口内仍被去重
      adapter.handleEvent(event);
      expect(mockHandler).toHaveBeenCalledTimes(1);

      // 30 秒后去重表清空，相同 messageId 能再次通过
      await vi.advanceTimersByTimeAsync(30_000);
      adapter.handleEvent(event);
      expect(mockHandler).toHaveBeenCalledTimes(2);
      adapter.destroy();
    });

    it('destroy 清理定时器后不再触发清空', async () => {
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg-destroy', chat_id: 'chat1' },
        },
      };
      adapter.handleEvent(event);
      adapter.enableReconnectDedup();
      adapter.destroy(); // 立即销毁

      // 30 秒后定时器已被取消，去重表不会被清空
      await vi.advanceTimersByTimeAsync(30_000);
      adapter.handleEvent(event);
      // destroy 后定时器被取消，seenMessageIds 没有清空，消息仍被去重
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('group chat filtering', () => {
    it('ignores group chat messages', () => {
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg-group', chat_id: 'chat_group', chat_type: 'group' },
        },
      });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('processes p2p messages', () => {
      adapter.handleEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user1' } },
          message: { message_type: 'text', content: '{"text":"hi"}', message_id: 'msg-p2p', chat_id: 'chat1', chat_type: 'p2p' },
        },
      });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });
});
