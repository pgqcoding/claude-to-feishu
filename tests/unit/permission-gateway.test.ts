import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionGateway } from '../../src/core/permission-gateway.js';
import type { MessageSender, FeishuCard } from '../../src/types.js';

function createMockSender(): MessageSender {
  return {
    send: vi.fn(async () => 'msg_perm_id'),
    update: vi.fn(async () => {}),
  };
}

/**
 * mock 卡片构建函数：返回包含 requestId 的固定结构，
 * 测试用例通过 elements[].actions[].value.requestId 提取 requestId
 */
function createMockBuildRequestCard() {
  return vi.fn((params: { toolName: string; toolInput: Record<string, unknown>; requestId: string; projectAlias: string }): FeishuCard => ({
    elements: [
      {
        tag: 'action',
        actions: [
          { tag: 'button', value: { action: 'allow', requestId: params.requestId } },
          { tag: 'button', value: { action: 'deny', requestId: params.requestId } },
        ],
      },
    ],
  }));
}

function createMockBuildDisabledCard() {
  return vi.fn((): FeishuCard => ({ elements: [{ tag: 'markdown', content: 'disabled' }] }));
}

/** 清空微任务队列，确保 Promise.resolve().then() 回调完成 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PermissionGateway', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('requestPermission', () => {
    it('sends permission card and registers pending request', async () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      // requestPermission 是同步注册 pending 的，调用后立即可见
      gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_1',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      // send 是同步调用（Promise.resolve 返回，但 card 构建是同步的）
      expect(sender.send).toHaveBeenCalledTimes(1);
      // pending 已同步注册
      expect(gateway.getPendingCount()).toBe(1);

      gateway.destroy();
    });

    it('returns a promise that stays pending until resolved', async () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      let settled = false;
      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_1',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });
      promise.then(() => { settled = true; }).catch(() => { settled = true; });

      await flushMicrotasks();
      // 未调用 resolvePermission，promise 应仍 pending
      expect(settled).toBe(false);

      gateway.destroy();
    });
  });

  describe('resolvePermission', () => {
    it('resolves pending request with allow', async () => {
      const sender = createMockSender();
      const buildRequestCard = createMockBuildRequestCard();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard,
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_1',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      // 从 buildRequestCard 的调用参数中提取 requestId
      const buildCall = buildRequestCard.mock.calls[0];
      const requestId = buildCall[0].requestId;

      // 等待 sender.send 的 Promise 完成，让 messageId 被更新进 pendingRequests
      await flushMicrotasks();

      const resolved = gateway.resolvePermission(requestId, 'allow', 'ou_user1');
      expect(resolved).not.toBeNull();
      expect(resolved!.resultText).toBe('allowed');

      const result = await promise;
      expect(result.behavior).toBe('allow');
      expect(sender.update).toHaveBeenCalled();

      gateway.destroy();
    });

    it('resolves pending request with deny', async () => {
      const sender = createMockSender();
      const buildRequestCard = createMockBuildRequestCard();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard,
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseID: 'tool_2',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      const requestId = buildRequestCard.mock.calls[0][0].requestId;

      await flushMicrotasks();

      gateway.resolvePermission(requestId, 'deny', 'ou_user1');
      const result = await promise;
      expect(result.behavior).toBe('deny');

      gateway.destroy();
    });
  });

  describe('timeout', () => {
    it('auto-denies after timeout', async () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_3',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      // 等待 messageId 写入 Map
      await flushMicrotasks();
      vi.advanceTimersByTime(120_000);
      const result = await promise;

      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('超时');
      // messageId 已写入（mock sender.send 返回 'msg_perm_id'），超时后应调用 update
      expect(sender.update).toHaveBeenCalled();

      gateway.destroy();
    });
  });

  describe('replay prevention', () => {
    it('rejects duplicate requestId', async () => {
      const sender = createMockSender();
      const buildRequestCard = createMockBuildRequestCard();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard,
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_4',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      const requestId = buildRequestCard.mock.calls[0][0].requestId;

      await flushMicrotasks();

      expect(gateway.resolvePermission(requestId, 'allow', 'ou_user1')).not.toBeNull();
      expect(gateway.resolvePermission(requestId, 'allow', 'ou_user1')).toBeNull();

      gateway.destroy();
    });
  });

  describe('open_id verification', () => {
    it('rejects if clicker open_id does not match requester', async () => {
      const sender = createMockSender();
      const buildRequestCard = createMockBuildRequestCard();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard,
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_5',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      const requestId = buildRequestCard.mock.calls[0][0].requestId;

      // 不需要 flushMicrotasks：pending 同步注册，open_id 验证不依赖 messageId
      const result = gateway.resolvePermission(requestId, 'allow', 'ou_attacker');
      expect(result).toBeNull();

      gateway.destroy();
    });
  });

  describe('process restart handling', () => {
    it('getPendingCount returns count of pending requests', () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      expect(gateway.getPendingCount()).toBe(0);

      gateway.requestPermission({
        toolName: 'Bash',
        toolInput: {},
        toolUseID: 'tool_6',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      // pending 同步注册，立即可见
      expect(gateway.getPendingCount()).toBe(1);

      gateway.destroy();
    });

    it('clearAll rejects all pending requests', async () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: {},
        toolUseID: 'tool_7',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      gateway.clearAll('进程重启，授权已失效');

      const result = await promise;
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('失效');
      expect(gateway.getPendingCount()).toBe(0);

      gateway.destroy();
    });
  });

  describe('/approve text command fallback', () => {
    it('resolves most recent pending request via text command', async () => {
      const sender = createMockSender();
      const gateway = new PermissionGateway({
        sender,
        defaultTimeoutMs: 120_000,
        buildRequestCard: createMockBuildRequestCard(),
        buildDisabledCard: createMockBuildDisabledCard(),
      });

      const promise = gateway.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool_8',
        chatId: 'chat_123',
        userOpenId: 'ou_user1',
        projectAlias: 'test',
      });

      // pending 同步注册，approveByTextCommand 可立即找到
      const resolved = gateway.approveByTextCommand('ou_user1', 'chat_123');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.behavior).toBe('allow');

      gateway.destroy();
    });
  });
});
