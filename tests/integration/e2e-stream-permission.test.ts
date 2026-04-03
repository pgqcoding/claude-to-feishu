import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamRenderer } from '../../src/feishu/stream-renderer.js';
import { PermissionGateway } from '../../src/core/permission-gateway.js';
import { TokenBucketLimiter } from '../../src/core/rate-limiter.js';
import { buildPermissionCard, buildDisabledPermissionCard } from '../../src/feishu/card-builder.js';
import type { MessageSender, MessageContent, FeishuCardContent } from '../../src/types.js';
import type { FeishuRateLimiters } from '../../src/core/rate-limiter.js';

// ===== 辅助：从卡片内容中提取 requestId =====

function extractRequestIdFromCard(card: FeishuCardContent): string {
  const actionEl = card.elements.find(
    (el) => (el as { tag: string }).tag === 'action',
  ) as { tag: 'action'; actions: Array<{ value: Record<string, string> }> } | undefined;
  if (!actionEl) throw new Error('卡片中未找到 action 元素');
  const requestId = actionEl.actions[0]?.value['requestId'];
  if (!requestId) throw new Error('action value 中未找到 requestId');
  return requestId;
}

// ===== 测试工厂函数 =====

/**
 * 创建会捕获授权卡片 requestId 的 MockSender
 * 每次调用 send 时，如果是授权卡片（包含 action 元素），自动记录 requestId
 */
function createCapturingSender() {
  let msgCounter = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let lastCapturedRequestId = '';

  const sender = {
    calls,
    get lastRequestId() {
      return lastCapturedRequestId;
    },
    send: vi.fn(async (chatId: string, content: MessageContent) => {
      msgCounter += 1;
      const messageId = `msg_${msgCounter}`;
      calls.push({ method: 'send', args: [chatId, content] });
      // 尝试从卡片中提取 requestId
      if (content.type === 'card') {
        try {
          lastCapturedRequestId = extractRequestIdFromCard(content.card);
        } catch {
          // 非授权卡片，忽略
        }
      }
      return messageId;
    }),
    update: vi.fn(async (messageId: string, content: MessageContent) => {
      calls.push({ method: 'update', args: [messageId, content] });
    }),
  } satisfies MessageSender & { calls: typeof calls; lastRequestId: string };

  return sender;
}

/** 创建普通 MockSender */
function createMockSender() {
  let msgCounter = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const sender = {
    calls,
    send: vi.fn(async (chatId: string, content: MessageContent) => {
      msgCounter += 1;
      calls.push({ method: 'send', args: [chatId, content] });
      return `msg_${msgCounter}`;
    }),
    update: vi.fn(async (messageId: string, content: MessageContent) => {
      calls.push({ method: 'update', args: [messageId, content] });
    }),
  } satisfies MessageSender & { calls: typeof calls };

  return sender;
}

/** 创建正常速率限制器（充足令牌） */
function createNormalLimiters(): FeishuRateLimiters {
  return {
    messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
    messageUpdate: new TokenBucketLimiter({ maxTokens: 4, refillRate: 4, name: 'update' }),
  };
}

/** 创建 PermissionGateway（注入 card-builder 工厂函数） */
function createGateway(sender: MessageSender, timeoutMs: number): PermissionGateway {
  return new PermissionGateway({
    sender,
    defaultTimeoutMs: timeoutMs,
    buildRequestCard: (params) =>
      buildPermissionCard({
        toolName: params.toolName,
        toolInput: params.toolInput,
        requestId: params.requestId,
        projectAlias: params.projectAlias,
      }),
    buildDisabledCard: (params) =>
      buildDisabledPermissionCard({
        toolName: params.toolName,
        toolInput: params.toolInput,
        result: params.result,
        projectAlias: params.projectAlias,
      }),
  });
}

// ===== 场景一：完整流程 =====

describe('E2E: 完整流程（流式渲染 → 工具授权 → 继续流式 → 完成）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式渲染 → 发起授权请求 → 用户允许 → 继续渲染 → 完成', async () => {
    const sender = createCapturingSender();
    const limiters = createNormalLimiters();
    const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test-project' });
    const gateway = createGateway(sender, 120_000);

    // 阶段1：开始流式渲染
    await renderer.start('chat_e2e_001');
    expect(renderer.currentState).toBe('streaming');
    expect(sender.send).toHaveBeenCalledTimes(1);

    // 阶段2：追加前半段内容
    renderer.appendChunk('正在分析代码...\n');
    await vi.advanceTimersByTimeAsync(500);
    expect(sender.update).toHaveBeenCalled();

    // 阶段3：发起工具授权请求（并发启动，通过 send mock 同步捕获 requestId）
    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'ls -la /tmp' },
      toolUseID: 'tool_use_001',
      chatId: 'chat_e2e_001',
      userOpenId: 'user_open_001',
      projectAlias: 'test-project',
    });
    expect(gateway.getPendingCount()).toBe(1);

    // 等待 send 异步完成（授权卡片发出后 requestId 写入 Map）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const requestId = sender.lastRequestId;
    expect(requestId).toBeTruthy();

    // 阶段4：用户点击"允许"按钮
    const resolved = gateway.resolvePermission(requestId, 'allow', 'user_open_001');
    expect(resolved).not.toBeNull();
    expect(resolved!.resultText).toBe('allowed');

    const permissionResult = await permissionPromise;
    expect(permissionResult.behavior).toBe('allow');
    expect(gateway.getPendingCount()).toBe(0);

    // 阶段5：继续渲染后半段内容
    renderer.appendChunk('命令执行完毕，结果如下：\n');
    renderer.appendChunk('total 0\n');
    await vi.advanceTimersByTimeAsync(500);

    // 阶段6：流式完成
    await renderer.complete();
    expect(renderer.currentState).toBe('completed');
    expect(renderer.currentContent).toContain('正在分析代码');
    expect(renderer.currentContent).toContain('命令执行完毕');

    gateway.destroy();
  });

  it('用户拒绝工具调用时返回 deny 结果', async () => {
    const sender = createCapturingSender();
    const gateway = createGateway(sender, 120_000);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Write',
      toolInput: { file_path: '/etc/passwd', content: 'evil' },
      toolUseID: 'tool_use_002',
      chatId: 'chat_e2e_002',
      userOpenId: 'user_open_002',
      projectAlias: 'test-project',
    });

    // 等待 send 完成
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const requestId = sender.lastRequestId;
    expect(requestId).toBeTruthy();

    // 模拟用户点击拒绝
    const resolved = gateway.resolvePermission(requestId, 'deny', 'user_open_002');
    expect(resolved).not.toBeNull();
    expect(resolved!.resultText).toBe('denied');

    const result = await permissionPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { behavior: 'deny'; message: string }).message).toContain('拒绝');

    gateway.destroy();
  });

  it('防重放：同一 requestId 只能使用一次', async () => {
    const sender = createCapturingSender();
    const gateway = createGateway(sender, 120_000);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'echo test' },
      toolUseID: 'tool_use_003',
      chatId: 'chat_e2e_003',
      userOpenId: 'user_open_003',
      projectAlias: 'test-project',
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const requestId = sender.lastRequestId;
    expect(requestId).toBeTruthy();

    // 第一次点击允许
    const firstResult = gateway.resolvePermission(requestId, 'allow', 'user_open_003');
    expect(firstResult).not.toBeNull();
    expect(firstResult!.resultText).toBe('allowed');
    await permissionPromise;

    // 第二次点击同一 requestId，应被拒绝（防重放）
    expect(gateway.resolvePermission(requestId, 'allow', 'user_open_003')).toBeNull();

    gateway.destroy();
  });
});

// ===== 场景二：授权超时降级 =====

describe('E2E: 授权超时降级', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('超时后自动返回 deny，并清理 pending 状态', async () => {
    const sender = createMockSender();
    // 使用 1000ms 超时便于测试
    const gateway = createGateway(sender, 1000);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      toolUseID: 'tool_use_timeout_001',
      chatId: 'chat_timeout_001',
      userOpenId: 'user_open_timeout_001',
      projectAlias: 'test-project',
    });

    expect(gateway.getPendingCount()).toBe(1);

    // 推进时间超过超时阈值
    await vi.advanceTimersByTimeAsync(1001);

    const result = await permissionPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { behavior: 'deny'; message: string }).message).toContain('超时');

    // 超时后 pending 应清空
    expect(gateway.getPendingCount()).toBe(0);

    gateway.destroy();
  });

  it('超时后 resolvePermission 返回 false（token 已标记使用）', async () => {
    const sender = createCapturingSender();
    const gateway = createGateway(sender, 500);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'test' },
      toolUseID: 'tool_use_timeout_002',
      chatId: 'chat_timeout_002',
      userOpenId: 'user_open_timeout_002',
      projectAlias: 'test-project',
    });

    // 等待 send 完成并捕获 requestId
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const capturedRequestId = sender.lastRequestId;
    expect(capturedRequestId).toBeTruthy();

    // 超时
    await vi.advanceTimersByTimeAsync(501);
    await permissionPromise;

    // 超时后用同一 requestId 调用 resolvePermission，应返回 false
    const afterTimeout = gateway.resolvePermission(
      capturedRequestId,
      'allow',
      'user_open_timeout_002',
    );
    expect(afterTimeout).toBeNull();

    gateway.destroy();
  });

  it('超时时 StreamRenderer 可继续正常工作（状态不受影响）', async () => {
    const sender = createMockSender();
    const limiters = createNormalLimiters();
    const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'test-project' });
    const gateway = createGateway(sender, 800);

    await renderer.start('chat_combined_001');
    renderer.appendChunk('开始处理...');

    // 发起授权请求但不等待
    const permissionPromise = gateway.requestPermission({
      toolName: 'Read',
      toolInput: { file_path: '/etc/hosts' },
      toolUseID: 'tool_use_timeout_003',
      chatId: 'chat_combined_001',
      userOpenId: 'user_open_003',
      projectAlias: 'test-project',
    });

    // 超时
    await vi.advanceTimersByTimeAsync(801);
    const result = await permissionPromise;
    expect(result.behavior).toBe('deny');

    // 渲染器状态不受授权超时影响，可以继续工作
    expect(renderer.currentState).toBe('streaming');
    renderer.appendChunk('（工具调用被拒，降级处理）');
    await renderer.complete();
    expect(renderer.currentState).toBe('completed');

    gateway.destroy();
  });

  it('clearAll 批量清理所有待处理请求', async () => {
    const sender = createMockSender();
    const gateway = createGateway(sender, 120_000);

    // 发起多个授权请求
    const p1 = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'cmd1' },
      toolUseID: 'tool_1',
      chatId: 'chat_001',
      userOpenId: 'user_001',
      projectAlias: 'proj',
    });
    const p2 = gateway.requestPermission({
      toolName: 'Write',
      toolInput: { file_path: '/tmp/x' },
      toolUseID: 'tool_2',
      chatId: 'chat_002',
      userOpenId: 'user_002',
      projectAlias: 'proj',
    });

    expect(gateway.getPendingCount()).toBe(2);

    // 模拟进程重启，批量清理
    gateway.clearAll('服务重启，授权失效');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('deny');
    expect((r1 as { behavior: 'deny'; message: string }).message).toContain('重启');
    expect(gateway.getPendingCount()).toBe(0);

    gateway.destroy();
  });
});

// ===== 场景三：QPS 限速保护 =====

describe('E2E: QPS 限速保护', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('messageUpdate 令牌耗尽时，StreamRenderer 降级为 degraded 状态', async () => {
    const sender = createMockSender();
    // update 令牌为 0，模拟 QPS 耗尽
    const limiters: FeishuRateLimiters = {
      messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
      messageUpdate: new TokenBucketLimiter({ maxTokens: 0, refillRate: 0, name: 'update-empty' }),
    };
    const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'rate-test' });

    await renderer.start('chat_rate_001');
    renderer.appendChunk('触发更新');

    // 推进定时器，tryAcquire 失败导致降级
    await vi.advanceTimersByTimeAsync(500);

    expect(renderer.currentState).toBe('degraded');
  });

  it('降级后 complete 改为文本分段发送', async () => {
    const sender = createMockSender();
    const limiters: FeishuRateLimiters = {
      messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
      messageUpdate: new TokenBucketLimiter({ maxTokens: 0, refillRate: 0, name: 'update-empty' }),
    };
    const renderer = new StreamRenderer({ sender, limiters, projectAlias: 'rate-test' });

    await renderer.start('chat_rate_002');
    // 超过 4096 字节的内容，触发分段发送
    renderer.appendChunk('A'.repeat(5000));
    await vi.advanceTimersByTimeAsync(500);

    // 此时已降级
    expect(renderer.currentState).toBe('degraded');

    await renderer.complete();
    expect(renderer.currentState).toBe('completed');

    // complete 后应以文本方式发送（type: 'text'）
    const textSends = sender.calls.filter(
      (c) => c.method === 'send' && (c.args[1] as { type: string })?.type === 'text',
    );
    expect(textSends.length).toBeGreaterThanOrEqual(1);
  });

  it('多 StreamRenderer 共享限速器，QPS 预算在会话间正确消耗', async () => {
    const sender = createMockSender();
    // update 仅 2 个令牌，不自动补充
    const limiters: FeishuRateLimiters = {
      messageSend: new TokenBucketLimiter({ maxTokens: 40, refillRate: 40, name: 'send' }),
      messageUpdate: new TokenBucketLimiter({ maxTokens: 2, refillRate: 0, name: 'update-limited' }),
    };

    const renderer1 = new StreamRenderer({ sender, limiters, projectAlias: 'proj-a' });
    const renderer2 = new StreamRenderer({ sender, limiters, projectAlias: 'proj-b' });

    await renderer1.start('chat_shared_001');
    await renderer2.start('chat_shared_002');

    // renderer1 消耗 1 token
    renderer1.appendChunk('内容A');
    await vi.advanceTimersByTimeAsync(500);

    // renderer2 消耗 1 token（共享）
    renderer2.appendChunk('内容B');
    await vi.advanceTimersByTimeAsync(500);

    // 2 个 token 耗尽，两个 renderer 均应处于 degraded 状态
    expect(limiters.messageUpdate.availableTokens).toBeLessThanOrEqual(0);
  });

  it('TokenBucketLimiter tryAcquire 在令牌耗尽后返回 false', () => {
    // 不依赖定时器，直接测试限流器逻辑
    const limiter = new TokenBucketLimiter({ maxTokens: 2, refillRate: 0, name: 'test' });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    // 第三次：令牌耗尽
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('TokenBucketLimiter waitForToken 超时后返回 false', async () => {
    // 此测试不使用 fake timers，需要 real timers
    vi.useRealTimers();

    const limiter = new TokenBucketLimiter({ maxTokens: 0, refillRate: 0, name: 'empty' });

    // timeoutMs 设为 50ms 确保快速完成
    const result = await limiter.waitForToken(50);
    expect(result).toBe(false);

    // 恢复 fake timers（afterEach 会再次调用 useRealTimers，无副作用）
    vi.useFakeTimers();
  });

  it('PermissionGateway 发卡失败时文本兜底并保留 pending 直到超时', async () => {
    const sender = createMockSender();
    const sendMock = sender.send as ReturnType<typeof vi.fn>;
    // 第一次（卡片）抛错，第二次（文本兜底）成功
    sendMock.mockRejectedValueOnce(new Error('网络错误，发卡失败'));
    sendMock.mockResolvedValueOnce('fallback_msg_id');

    const gateway = createGateway(sender, 5_000);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'test' },
      toolUseID: 'tool_fail_001',
      chatId: 'chat_fail_001',
      userOpenId: 'user_fail_001',
      projectAlias: 'test-project',
    });

    // 等待 rejected promise 的 .catch() 链完成（文本兜底发送）
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    // 卡片失败后请求仍 pending（等待 /approve 或超时）
    expect(gateway.getPendingCount()).toBe(1);
    // 验证文本兜底消息已发送（send 被调用 2 次：卡片 + 文本兜底）
    expect(sendMock).toHaveBeenCalledTimes(2);
    const fallbackCall = sendMock.mock.calls[1];
    expect(fallbackCall[1]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('/approve') }),
    );

    // 推进到超时，promise 应以 deny 解决
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await permissionPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { behavior: 'deny'; message: string }).message).toContain('超时');

    gateway.destroy();
  });

  it('身份校验：非请求者点击授权卡片返回 false', async () => {
    const sender = createCapturingSender();
    const gateway = createGateway(sender, 120_000);

    const permissionPromise = gateway.requestPermission({
      toolName: 'Bash',
      toolInput: { command: 'test' },
      toolUseID: 'tool_identity_001',
      chatId: 'chat_identity_001',
      userOpenId: 'user_real_owner',
      projectAlias: 'test-project',
    });

    // 等待 send 完成
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const requestId = sender.lastRequestId;
    expect(requestId).toBeTruthy();

    // 用另一个用户 open_id 尝试授权，应被拒绝
    const resolvedByStranger = gateway.resolvePermission(
      requestId,
      'allow',
      'user_another_person',
    );
    expect(resolvedByStranger).toBeNull();
    expect(gateway.getPendingCount()).toBe(1); // 请求仍处于 pending

    // 真正的请求者点击，应该成功
    const resolvedByOwner = gateway.resolvePermission(requestId, 'allow', 'user_real_owner');
    expect(resolvedByOwner).not.toBeNull();
    expect(resolvedByOwner!.resultText).toBe('allowed');
    expect(gateway.getPendingCount()).toBe(0);

    gateway.destroy();

    const result = await permissionPromise;
    expect(result.behavior).toBe('allow');

    gateway.destroy();
  });
});
