import { parseCommand, WELCOME_TEXT, RetryStore } from '../feishu/commands/index.js';
import type { Store } from '../core/store.js';
import type { SessionManager } from '../core/session-manager.js';
import type { SdkBridge, CanUseToolCallback } from '../core/sdk-bridge.js';
import type { FeishuSender } from '../feishu/sender.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { PermissionGateway } from '../core/permission-gateway.js';
import { COMMAND_HANDLERS } from './command-handlers.js';
import type { CommandContext } from './command-handlers.js';

export interface HandlerDeps {
  readonly sessionManager: Pick<
    SessionManager,
    'listSessions' | 'switchSession' | 'getCurrentBinding' | 'getAvailableDirs' | 'resolveAlias'
  >;
  readonly sender: Pick<FeishuSender, 'send' | 'clearUnreachable' | 'addReaction' | 'removeReaction'>;
  readonly bridge: Pick<SdkBridge, 'sendQuery' | 'queryStream' | 'abortSession' | 'activeQueryCount'>;
  readonly config: { readonly maxConcurrentQueries: number; readonly defaultModel: string };
  readonly store: Pick<Store, 'load' | 'save'>;
  readonly logger: Pick<Logger, 'info' | 'error'>;
  /** 可选：权限网关，提供后普通消息路径串联 canUseTool 回调，并支持 /approve 命令 */
  readonly permissionGateway?: Pick<PermissionGateway, 'requestPermission' | 'approveByTextCommand'>;
}

/**
 * 创建消息处理器（纯函数，依赖注入）
 *
 * 每个 chatId 维护一个 Promise 链，保证同一聊天的消息串行处理，
 * 防止并发 switchSession / store.save 导致状态竞态。
 */
export function createMessageHandler(deps: HandlerDeps) {
  const { sessionManager, sender, bridge, config, store, logger } = deps;
  const chatQueues = new Map<string, Promise<void>>();
  // 内部状态：记录每个 chatId 的最后一次查询，用于 /retry
  const retryStore = new RetryStore();

  async function sendText(chatId: string, text: string): Promise<void> {
    await sender.send(chatId, { type: 'text', text });
  }

  /** 内部错误：完整信息记录日志，仅向用户展示通用提示，不泄露内部细节 */
  async function sendInternalError(chatId: string, err: unknown, context: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${context}: ${message}`, { module: 'handler' });
    await sendText(chatId, `内部错误：${context}，请查看 daemon 日志`);
  }

  async function processMessage(msg: IncomingMessage): Promise<void> {
    sender.clearUnreachable(msg.chatId);
    const parsed = parseCommand(msg.text);

    if (parsed.type === 'command') {
      const commandHandler = COMMAND_HANDLERS.get(parsed.name);
      if (!commandHandler) {
        // 未知命令，给出明确反馈
        await sendText(msg.chatId, `未知命令 /${parsed.name}，输入 /help 查看可用命令`);
        return;
      }
      const ctx: CommandContext = {
        chatId: msg.chatId,
        userOpenId: msg.openId,
        args: parsed.args,
        deps,
        retryStore,
        sendText,
        sendInternalError,
      };
      try {
        await commandHandler(ctx);
      } catch (err) {
        await sendInternalError(msg.chatId, err, `命令 /${parsed.name} 执行失败`);
      }
      return;
    }

    // 普通消息 → 发送到 Claude
    let currentBinding;
    try {
      currentBinding = await sessionManager.getCurrentBinding();
    } catch (err) {
      await sendInternalError(msg.chatId, err, '获取当前绑定失败');
      return;
    }

    if (!currentBinding) {
      await sendText(msg.chatId, WELCOME_TEXT);
      return;
    }

    if (bridge.activeQueryCount >= config.maxConcurrentQueries) {
      await sendText(msg.chatId, '请等待当前消息处理完成');
      return;
    }

    // 即时反馈：用 Reaction 表示处理中状态，避免消息刷屏
    let reactionId = '';
    try {
      reactionId = await deps.sender.addReaction(msg.messageId, 'THINKING');
    } catch (err) {
      // Reaction 失败时降级到文本消息
      await sendText(msg.chatId, '⏳ 正在处理...');
    }

    // 构建 canUseTool 回调：有权限网关时串联授权流程，否则自动放行
    const { permissionGateway } = deps;
    const canUseTool: CanUseToolCallback | undefined = permissionGateway
      ? async (toolName, input, opts) =>
          permissionGateway.requestPermission({
            toolName,
            toolInput: input,
            toolUseID: opts.toolUseID,
            chatId: msg.chatId,
            userOpenId: msg.openId,
            projectAlias: currentBinding.projectAlias,
          })
      : undefined;

    try {
      const text = await bridge.queryStream({
        prompt: parsed.text,
        cwd: currentBinding.projectDir,
        sessionId: currentBinding.sessionId,
        canUseTool,
      });
      // 记录查询结果，供 /retry 使用
      retryStore.record({
        prompt: parsed.text,
        chatId: msg.chatId,
        sessionId: currentBinding.sessionId,
        projectDir: currentBinding.projectDir,
        success: true,
        timestamp: Date.now(),
      });
      // 删除处理中 Reaction
      if (reactionId) {
        try {
          await deps.sender.removeReaction(msg.messageId, reactionId);
        } catch {
          // 删除失败不影响主流程
        }
      }
      await sendText(msg.chatId, text);
    } catch (err) {
      // 异常路径记录失败，供 /retry 使用
      retryStore.record({
        prompt: parsed.text,
        chatId: msg.chatId,
        sessionId: currentBinding.sessionId,
        projectDir: currentBinding.projectDir,
        success: false,
        timestamp: Date.now(),
      });
      // 删除处理中 Reaction
      if (reactionId) {
        try {
          await deps.sender.removeReaction(msg.messageId, reactionId);
        } catch {
          // 删除失败不影响主流程
        }
      }
      // 区分 abort 类错误和其他异常，给用户友好提示
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(errMsg)) {
        logger.info(`查询被中止: ${errMsg}`, { module: 'handler' });
        await sendText(msg.chatId, '查询已中止，可能原因：超时、会话被终止或 CLI 进程退出。可用 /retry 重试。');
      } else {
        await sendInternalError(msg.chatId, err, '查询执行异常');
      }
    }
  }

  return function handleMessage(msg: IncomingMessage): Promise<void> {
    const prev = chatQueues.get(msg.chatId) ?? Promise.resolve();
    const next = prev.then(() => processMessage(msg)).catch(() => {});
    chatQueues.set(msg.chatId, next);
    // 队列空闲时自清理，防止 chatQueues 无限增长
    void next.finally(() => {
      if (chatQueues.get(msg.chatId) === next) {
        chatQueues.delete(msg.chatId);
      }
    });
    return next;
  };
}
