import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMessageHandler } from '../../src/daemon/handler.js';
import type { HandlerDeps } from '../../src/daemon/handler.js';

function createMockDeps() {
  return {
    sessionManager: {
      listSessions: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn(),
      getCurrentBinding: vi.fn().mockResolvedValue(null),
      getAvailableDirs: vi.fn().mockReturnValue([]),
      resolveAlias: vi.fn().mockReturnValue(null),
    },
    sender: {
      send: vi.fn().mockResolvedValue('msg_id'),
      update: vi.fn(),
      clearUnreachable: vi.fn(),
      isUnreachable: vi.fn().mockReturnValue(false),
    },
    bridge: {
      sendQuery: vi.fn(),
      queryStream: vi.fn(),
      abortSession: vi.fn(),
      activeQueryCount: 0,
    },
    config: {
      maxConcurrentQueries: 3,
      defaultModel: 'sonnet',
    },
    store: {
      load: vi.fn().mockResolvedValue({
        version: 1,
        currentBinding: null,
        recentSessionIds: [],
      }),
      save: vi.fn().mockResolvedValue(true),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('createMessageHandler', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handler: ReturnType<typeof createMessageHandler>;
  const msg = { openId: 'ou_user1', chatId: 'chat_1', messageId: 'msg_1', text: '' };

  beforeEach(() => {
    deps = createMockDeps();
    handler = createMessageHandler(deps);
  });

  it('responds to /help with help text', async () => {
    await handler({ ...msg, text: '/help' });
    expect(deps.sender.send).toHaveBeenCalledTimes(1);
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('/list');
    expect(text).toContain('/switch');
  });

  it('responds to /list with empty message when no sessions', async () => {
    await handler({ ...msg, text: '/list' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('暂无');
  });

  it('responds to /switch without args with usage hint', async () => {
    await handler({ ...msg, text: '/switch' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('请指定');
  });

  it('responds to /status with no binding message', async () => {
    await handler({ ...msg, text: '/status' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有绑定');
  });

  it('sends welcome text for plain message without binding', async () => {
    await handler({ ...msg, text: '帮我看看这个 bug' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('欢迎');
  });

  it('未知命令 → 回复提示并包含 /help', async () => {
    await handler({ ...msg, text: '/foo' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('/foo');
    expect(text).toContain('/help');
  });

  it('sends processing feedback then query result for bound session', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/project',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockResolvedValue('Claude 回复');

    await handler({ ...msg, text: '帮我看看这个 bug' });

    // 应先发 ⏳ 占位消息，再发结果
    expect(deps.sender.send).toHaveBeenCalledTimes(2);
    expect(deps.sender.send.mock.calls[0][1].text).toContain('⏳');
    expect(deps.sender.send.mock.calls[1][1].text).toContain('Claude 回复');
  });

  it('does not leak internal error details to user', async () => {
    deps.sessionManager.getCurrentBinding.mockRejectedValue(
      new Error('ENOENT: /home/user/.claude-to-feishu/state.json')
    );

    await handler({ ...msg, text: '/status' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).not.toContain('ENOENT');
    expect(text).not.toContain('.claude-to-feishu');
    expect(text).toContain('内部错误');
  });

  it('serializes concurrent messages per chatId', async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;
    const firstBlocks = new Promise<void>(r => { resolveFirst = r; });

    deps.sessionManager.listSessions
      .mockImplementationOnce(async () => { await firstBlocks; order.push(1); return []; })
      .mockImplementationOnce(async () => { order.push(2); return []; });

    const p1 = handler({ ...msg, text: '/list' });
    const p2 = handler({ ...msg, text: '/list' });

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  // --- /new 命令 ---

  it('/new 有参数且别名存在 → 创建新会话并回复成功', async () => {
    deps.sessionManager.resolveAlias.mockReturnValue('/work/myproject');
    deps.bridge.sendQuery = vi.fn().mockResolvedValue({ success: true });

    await handler({ ...msg, text: '/new myproject' });

    expect(deps.sessionManager.resolveAlias).toHaveBeenCalledWith('myproject');
    expect(deps.bridge.sendQuery).toHaveBeenCalledWith({ prompt: 'start', cwd: '/work/myproject' });
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('新会话已创建');
    expect(text).toContain('myproject');
  });

  it('/new 无参数 → 列出可用目录', async () => {
    deps.sessionManager.getAvailableDirs.mockReturnValue([
      { alias: 'proj-a', dir: '/work/proj-a' },
      { alias: 'proj-b', dir: '/work/proj-b' },
    ]);

    await handler({ ...msg, text: '/new' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('proj-a');
    expect(text).toContain('proj-b');
    expect(text).toContain('/new <别名>');
  });

  it('/new 别名不存在 → 返回错误提示', async () => {
    // resolveAlias 默认返回 null
    await handler({ ...msg, text: '/new nonexistent' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('未找到别名');
    expect(text).toContain('nonexistent');
  });

  it('/new sendQuery 返回 success: false → 回复失败提示', async () => {
    deps.sessionManager.resolveAlias.mockReturnValue('/work/proj');
    deps.bridge.sendQuery = vi.fn().mockResolvedValue({ success: false, error: 'timeout' });

    await handler({ ...msg, text: '/new proj' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('失败');
  });

  // --- /stop 命令 ---

  it('/stop 有绑定会话且有活跃查询 → 发送终止信号', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-abc',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    // 模拟有活跃查询
    (deps.bridge as any).activeQueryCount = 1;

    await handler({ ...msg, text: '/stop' });

    expect(deps.bridge.abortSession).toHaveBeenCalledWith('sess-abc');
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('终止信号');
  });

  it('/stop 有绑定会话但无活跃查询 → 提示没有正在进行的查询', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-abc',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    // activeQueryCount 默认为 0

    await handler({ ...msg, text: '/stop' });

    expect(deps.bridge.abortSession).not.toHaveBeenCalled();
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有正在进行的查询');
  });

  it('/stop 无绑定会话 → 提示无活动查询', async () => {
    // getCurrentBinding 默认返回 null

    await handler({ ...msg, text: '/stop' });

    expect(deps.bridge.abortSession).not.toHaveBeenCalled();
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有绑定');
  });

  // --- 并发流控 ---

  it('activeQueryCount >= maxConcurrentQueries 时拒绝普通消息', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    // 超出并发限制
    (deps.bridge as any).activeQueryCount = 3;

    await handler({ ...msg, text: '普通消息' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('等待');
    expect(deps.bridge.queryStream).not.toHaveBeenCalled();
  });

  // --- sendQuery 失败路径 ---

  it('queryStream 抛出异常 → 进入 catch 路径，回复内部错误', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockRejectedValue(new Error('network error'));

    await handler({ ...msg, text: '普通消息' });

    const calls = deps.sender.send.mock.calls;
    expect(calls[1][1].text).toContain('内部错误');
    // 不泄露原始错误信息给用户
    expect(calls[1][1].text).not.toContain('network error');
  });

  it('queryStream abort 异常 → 友好提示而非内部错误', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockRejectedValue(
      new Error('Claude Code process aborted by user'),
    );

    await handler({ ...msg, text: '普通消息' });

    const calls = deps.sender.send.mock.calls;
    expect(calls[1][1].text).toContain('查询已中止');
    expect(calls[1][1].text).toContain('/retry');
    expect(calls[1][1].text).not.toContain('内部错误');
  });

  // --- /sessions 命令 ---

  it('/sessions 空列表 → 返回暂无会话提示', async () => {
    // listSessions 默认返回空数组
    await handler({ ...msg, text: '/sessions' });

    expect(deps.sessionManager.listSessions).toHaveBeenCalledWith(false);
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('暂无');
  });

  it('/sessions refresh → 以 forceRefresh=true 调用 listSessions', async () => {
    await handler({ ...msg, text: '/sessions refresh' });

    expect(deps.sessionManager.listSessions).toHaveBeenCalledWith(true);
  });

  it('/sessions 有会话且有绑定 → 当前会话显示 ▶ 标记', async () => {
    const session = {
      sessionId: 'sess-abc-12345678',
      summary: '测试会话',
      lastModified: Date.now(),
      cwd: '/work/proj',
    };
    deps.sessionManager.listSessions.mockResolvedValue([session]);
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-abc-12345678',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });

    await handler({ ...msg, text: '/sessions' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('▶');
    expect(text).toContain('测试会话');
    expect(text).toContain('ID: sess-abc');
  });

  // --- /history 命令 ---

  it('/history 无绑定会话 → 提示没有绑定', async () => {
    // getCurrentBinding 默认返回 null

    await handler({ ...msg, text: '/history' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有绑定');
    expect(deps.sessionManager.listSessions).not.toHaveBeenCalled();
  });

  it('/history 有绑定会话且在 sessions 列表中 → 显示会话信息', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-history-test',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.sessionManager.listSessions.mockResolvedValue([
      {
        sessionId: 'sess-history-test',
        summary: '历史测试会话',
        lastModified: 1700000000000,
        cwd: '/work/proj',
        firstPrompt: '第一个问题',
      },
    ]);

    await handler({ ...msg, text: '/history' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('当前会话信息');
    expect(text).toContain('sess-history'); // 前 12 字符
    expect(text).toContain('历史测试会话');
  });

  it('/history 有绑定会话但不在 sessions 列表 → 显示简化信息', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-unknown-123',
      projectDir: '/work/proj',
      projectAlias: 'myproject',
      boundAt: Date.now(),
    });
    // listSessions 返回空列表，不含当前绑定的 session
    deps.sessionManager.listSessions.mockResolvedValue([]);

    await handler({ ...msg, text: '/history' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('sess-unknown-123'.slice(0, 12));
    expect(text).toContain('myproject');
  });

  // --- /model 命令 ---

  it('/model 无参数 → 返回当前模型（降级到 defaultModel）', async () => {
    // store.load 返回无 activeModel 的状态，降级到 config.defaultModel
    await handler({ ...msg, text: '/model' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('sonnet');
    expect(text).toContain('当前模型');
  });

  it('/model 无参数且 state 有 activeModel → 显示 activeModel', async () => {
    deps.store.load.mockResolvedValue({
      version: 1,
      currentBinding: null,
      recentSessionIds: [],
      activeModel: 'opus',
    });

    await handler({ ...msg, text: '/model' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('opus');
    expect(text).toContain('当前模型');
  });

  it('/model opus → 切换模型并保存状态', async () => {
    await handler({ ...msg, text: '/model opus' });

    expect(deps.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ activeModel: 'opus' })
    );
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('opus');
    expect(text).toContain('切换');
  });

  it('/model invalid → 返回错误提示，不调用 store.save', async () => {
    await handler({ ...msg, text: '/model invalid-model' });

    expect(deps.store.save).not.toHaveBeenCalled();
    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('不支持');
    expect(text).toContain('invalid-model');
  });

  // --- /retry 命令 ---

  it('/retry 无可重试查询 → 返回提示', async () => {
    await handler({ ...msg, text: '/retry' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有可重试');
    expect(deps.bridge.sendQuery).not.toHaveBeenCalled();
  });

  it('/retry 上次查询成功 → 不可重试，返回提示', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockResolvedValue('成功回复');

    // 先发一条成功的消息
    await handler({ ...msg, text: '成功的查询' });
    deps.sender.send.mockClear();

    // 再发 /retry，不应重试
    await handler({ ...msg, text: '/retry' });

    const text = deps.sender.send.mock.calls[0][1].text;
    expect(text).toContain('没有可重试');
  });

  it('/retry 上次查询失败 → 重试并回复成功结果', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    // 普通消息路径用 queryStream，抛异常表示失败
    deps.bridge.queryStream = vi.fn().mockRejectedValue(new Error('api error'));

    // 先发一条失败的消息
    await handler({ ...msg, text: '失败的查询' });
    deps.sender.send.mockClear();

    // 重试时恢复成功（/retry 走 sendQuery）
    deps.bridge.sendQuery = vi.fn().mockResolvedValue({ text: '重试成功回复', success: true });
    await handler({ ...msg, text: '/retry' });

    const calls = deps.sender.send.mock.calls;
    // 第一条是 ⏳ 重试提示，第二条是结果
    expect(calls[0][1].text).toContain('⏳');
    expect(calls[1][1].text).toContain('重试成功回复');
  });

  it('/retry 重试仍然失败 → 返回失败提示并记录日志', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    // 普通消息路径用 queryStream，抛异常表示失败
    deps.bridge.queryStream = vi.fn().mockRejectedValue(new Error('api error'));

    // 先发一条失败消息
    await handler({ ...msg, text: '失败查询' });
    deps.sender.send.mockClear();
    deps.logger.error.mockClear();

    // 重试仍失败（/retry 走 sendQuery）
    deps.bridge.sendQuery = vi.fn().mockResolvedValue({ text: '', success: false, error: 'api error' });
    await handler({ ...msg, text: '/retry' });

    const calls = deps.sender.send.mock.calls;
    expect(calls[1][1].text).toContain('重试仍然失败');
    expect(deps.logger.error).toHaveBeenCalled();
  });

  // --- 权限网关集成 ---

  it('有 permissionGateway 时，queryStream 收到 canUseTool 回调', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockResolvedValue('回复内容');

    const mockGateway = {
      requestPermission: vi.fn().mockResolvedValue({ behavior: 'allow' }),
    };
    const handlerWithGateway = createMessageHandler({ ...deps, permissionGateway: mockGateway });
    await handlerWithGateway({ ...msg, text: '普通消息' });

    // queryStream 应被调用，且 canUseTool 是函数
    expect(deps.bridge.queryStream).toHaveBeenCalledTimes(1);
    const callArgs = deps.bridge.queryStream.mock.calls[0][0];
    expect(typeof callArgs.canUseTool).toBe('function');

    // 模拟 SDK 调用 canUseTool
    const result = await callArgs.canUseTool('bash', { cmd: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu_123',
    });
    expect(mockGateway.requestPermission).toHaveBeenCalledWith({
      toolName: 'bash',
      toolInput: { cmd: 'ls' },
      toolUseID: 'tu_123',
      chatId: 'chat_1',
      userOpenId: 'ou_user1',
      projectAlias: 'proj',
    });
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('无 permissionGateway 时，queryStream 的 canUseTool 为 undefined', async () => {
    deps.sessionManager.getCurrentBinding.mockResolvedValue({
      sessionId: 'sess-1',
      projectDir: '/work/proj',
      projectAlias: 'proj',
      boundAt: Date.now(),
    });
    deps.bridge.queryStream = vi.fn().mockResolvedValue('回复');

    await handler({ ...msg, text: '普通消息' });

    const callArgs = deps.bridge.queryStream.mock.calls[0][0];
    expect(callArgs.canUseTool).toBeUndefined();
  });
});
