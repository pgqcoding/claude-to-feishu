import {
  HELP_TEXT,
  formatSessionInfo,
  formatSessions,
  formatCurrentModel,
  validateModel,
  resolveSession,
  buildForkPrompt,
  formatForkSuccess,
} from '../feishu/commands/index.js';
import type { ResumeSuccess } from '../feishu/commands/index.js';
import type { RetryStore } from '../feishu/commands/index.js';
import type { HandlerDeps } from './handler.js';

/** 命令处理上下文 */
export interface CommandContext {
  readonly chatId: string;
  readonly userOpenId: string;
  readonly args: string;
  readonly deps: HandlerDeps;
  readonly retryStore: RetryStore;
  readonly sendText: (chatId: string, text: string) => Promise<void>;
  readonly sendInternalError: (chatId: string, err: unknown, context: string) => Promise<void>;
}

/** 命令处理函数类型 */
export type CommandHandler = (ctx: CommandContext) => Promise<void>;

async function handleHelp({ chatId, sendText }: CommandContext): Promise<void> {
  await sendText(chatId, HELP_TEXT);
}

async function handleList({ chatId, deps, sendText }: CommandContext): Promise<void> {
  const sessions = await deps.sessionManager.listSessions();
  if (sessions.length === 0) {
    await sendText(chatId, '暂无可用会话。请先在 CLI 中创建会话，或用 /new 创建。');
    return;
  }
  let text = '可用会话：\n\n';
  sessions.forEach((s, i) => {
    const date = new Date(s.lastModified).toLocaleString('zh-CN');
    const title = s.customTitle ?? s.summary ?? s.firstPrompt?.slice(0, 50) ?? '(无标题)';
    text += `${i + 1}. ${title}\n   ${date} | ${s.cwd}\n\n`;
  });
  text += '使用 /switch <序号> 切换会话';
  await sendText(chatId, text);
}

async function handleSwitch({ chatId, args, deps, sendText }: CommandContext): Promise<void> {
  if (!args) {
    await sendText(chatId, '请指定会话序号，如 /switch 1');
    return;
  }
  const binding = await deps.sessionManager.switchSession(args);
  await sendText(chatId, `已切换到会话 [${binding.projectAlias}]`);
}

async function handleNew({ chatId, args, deps, sendText }: CommandContext): Promise<void> {
  if (!args) {
    const dirs = deps.sessionManager.getAvailableDirs();
    let text = '可用项目目录：\n\n';
    dirs.forEach((d, i) => { text += `${i + 1}. ${d.alias} → ${d.dir}\n`; });
    text += '\n使用 /new <别名> 创建新会话';
    await sendText(chatId, text);
    return;
  }
  const dir = deps.sessionManager.resolveAlias(args);
  if (!dir) {
    await sendText(chatId, `未找到别名 "${args}"，请用 /new 查看可用目录`);
    return;
  }
  const result = await deps.bridge.sendQuery({ prompt: 'start', cwd: dir });
  if (result.success) {
    await sendText(chatId, `新会话已创建 [${args}]`);
  } else {
    await sendText(chatId, '创建会话失败，请查看日志');
  }
}

async function handleStop({ chatId, deps, sendText }: CommandContext): Promise<void> {
  const binding = await deps.sessionManager.getCurrentBinding();
  if (!binding) {
    await sendText(chatId, '当前没有绑定的会话');
    return;
  }
  if (deps.bridge.activeQueryCount === 0) {
    await sendText(chatId, '当前没有正在进行的查询');
    return;
  }
  deps.bridge.abortSession(binding.sessionId);
  await sendText(chatId, '已发送终止信号');
}

async function handleHistory({ chatId, deps, sendText }: CommandContext): Promise<void> {
  const binding = await deps.sessionManager.getCurrentBinding();
  if (!binding) {
    await sendText(chatId, '当前没有绑定的会话。使用 /list 查看。');
    return;
  }
  const sessions = await deps.sessionManager.listSessions();
  const session = sessions.find(s => s.sessionId === binding.sessionId);
  if (session) {
    await sendText(chatId, formatSessionInfo(session));
  } else {
    await sendText(
      chatId,
      `当前会话: ${binding.sessionId.slice(0, 12)}...\n项目: ${binding.projectAlias}`,
    );
  }
}

async function handleSessions({ chatId, args, deps, sendText }: CommandContext): Promise<void> {
  const forceRefresh = args.toLowerCase() === 'refresh';
  const sessions = await deps.sessionManager.listSessions(forceRefresh);
  const currentBinding = await deps.sessionManager.getCurrentBinding();
  const text = formatSessions({ sessions, currentBinding });
  await sendText(chatId, text);
}

async function handleModel({ chatId, args, deps, sendText }: CommandContext): Promise<void> {
  if (!args) {
    const state = await deps.store.load();
    const current = state.activeModel ?? deps.config.defaultModel;
    await sendText(chatId, formatCurrentModel(current));
    return;
  }
  const modelResult = validateModel(args);
  if (!modelResult.valid) {
    await sendText(chatId, modelResult.error);
    return;
  }
  const currentState = await deps.store.load();
  await deps.store.save({ ...currentState, activeModel: modelResult.model });
  await sendText(chatId, `模型已切换为：${modelResult.model}`);
}

async function handleStatus({ chatId, deps, sendText }: CommandContext): Promise<void> {
  const currentBinding = await deps.sessionManager.getCurrentBinding();
  if (currentBinding) {
    await sendText(
      chatId,
      `当前状态：\n` +
      `会话: ${currentBinding.sessionId.slice(0, 12)}\n` +
      `项目: ${currentBinding.projectAlias}\n` +
      `目录: ${currentBinding.projectDir}\n` +
      `绑定: ${new Date(currentBinding.boundAt).toLocaleString('zh-CN')}\n` +
      `活跃查询: ${deps.bridge.activeQueryCount}`,
    );
  } else {
    await sendText(chatId, '当前没有绑定的会话。使用 /list 查看。');
  }
}

async function handleResume({ chatId, args, deps, sendText }: CommandContext): Promise<void> {
  if (!args) {
    await sendText(chatId, '请指定会话 ID 前缀或序号，如 /resume abc1 或 /resume 3');
    return;
  }
  const sessions = await deps.sessionManager.listSessions();
  const result = resolveSession(sessions, args);
  if (!result.success) {
    await sendText(chatId, result.message);
    return;
  }
  const resolved = result as ResumeSuccess;
  const binding = await deps.sessionManager.switchSession(resolved.sessionId);
  await sendText(chatId, `已恢复会话 [${binding.projectAlias}] (${resolved.sessionId.slice(0, 8)})`);
}

async function handleFork({ chatId, deps, sendText }: CommandContext): Promise<void> {
  const forkBinding = await deps.sessionManager.getCurrentBinding();
  if (!forkBinding) {
    await sendText(chatId, '当前没有绑定的会话。使用 /list 查看。');
    return;
  }
  const forkParams = {
    currentSessionId: forkBinding.sessionId,
    projectDir: forkBinding.projectDir,
    projectAlias: forkBinding.projectAlias,
  };
  const forkPrompt = buildForkPrompt(forkParams);
  await sendText(chatId, '⏳ 正在创建分支会话...');
  const forkResult = await deps.bridge.sendQuery({ prompt: forkPrompt, cwd: forkBinding.projectDir });
  if (forkResult.success) {
    await sendText(chatId, formatForkSuccess(forkParams));
  } else {
    await sendText(chatId, '创建分支会话失败，请查看日志');
  }
}

async function handleRetry(
  { chatId, deps, retryStore, sendText, sendInternalError }: CommandContext,
): Promise<void> {
  const retryable = retryStore.getRetryable(chatId);
  if (!retryable) {
    await sendText(chatId, '没有可重试的查询。仅在上次查询失败时可用。');
    return;
  }
  await sendText(chatId, `⏳ 正在重试: ${retryable.prompt.slice(0, 50)}...`);
  try {
    const result = await deps.bridge.sendQuery({
      prompt: retryable.prompt,
      cwd: retryable.projectDir,
      sessionId: retryable.sessionId,
    });
    retryStore.record({ ...retryable, success: result.success, timestamp: Date.now() });
    if (result.success) {
      await sendText(chatId, result.text);
    } else {
      await sendText(chatId, '重试仍然失败，请查看日志');
      deps.logger.error('重试查询失败', { error: result.error, module: 'handler' });
    }
  } catch (err) {
    retryStore.record({ ...retryable, success: false, timestamp: Date.now() });
    await sendInternalError(chatId, err, '重试执行异常');
  }
}

async function handleApprove({ chatId, userOpenId, deps, sendText }: CommandContext): Promise<void> {
  const { permissionGateway } = deps;
  if (!permissionGateway) {
    await sendText(chatId, '权限网关未启用，无需手动审批');
    return;
  }
  const approved = permissionGateway.approveByTextCommand(userOpenId, chatId);
  if (approved) {
    await sendText(chatId, '已批准最新待处理的工具调用请求');
  } else {
    await sendText(chatId, '没有待处理的工具调用请求');
  }
}

/** 命令路由表 */
export const COMMAND_HANDLERS: ReadonlyMap<string, CommandHandler> = new Map([
  ['help', handleHelp],
  ['list', handleList],
  ['switch', handleSwitch],
  ['new', handleNew],
  ['stop', handleStop],
  ['history', handleHistory],
  ['sessions', handleSessions],
  ['model', handleModel],
  ['status', handleStatus],
  ['resume', handleResume],
  ['fork', handleFork],
  ['retry', handleRetry],
  ['approve', handleApprove],
]);
