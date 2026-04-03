/** /fork 命令所需参数 */
export interface ForkParams {
  readonly currentSessionId: string;
  readonly projectDir: string;
  readonly projectAlias: string;
}

/**
 * 构建 fork 发送给 Claude 的 prompt
 * 告知 Claude 这是基于上一个会话的分支，让其延续上下文
 */
export function buildForkPrompt(params: ForkParams): string {
  return `继续之前的对话。上一个会话 ID: ${params.currentSessionId}`;
}

/**
 * 格式化 fork 成功后返回给用户的消息
 */
export function formatForkSuccess(params: ForkParams): string {
  const idPrefix = params.currentSessionId.slice(0, 8);
  const alias = params.projectAlias || '(未命名)';
  return `分支会话已创建 [${alias}]，继承自会话 ${idPrefix}`;
}
