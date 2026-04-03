/** 会话历史格式化工具 */

/** 单条消息记录（只读） */
export interface MessageRecord {
  readonly uuid: string;
  readonly role: 'user' | 'assistant';
  readonly summary: string; // 已截断到 80 字符
  readonly timestamp: number;
}

/** 将会话消息列表格式化为飞书文本 */
export function formatHistory(messages: MessageRecord[]): string {
  if (messages.length === 0) {
    return '当前会话暂无历史消息。';
  }

  const header = `对话历史（最近 ${messages.length} 条）：\n\n`;
  const lines = messages.map((m, i) => {
    const roleLabel = m.role === 'user' ? '👤 用户' : '🤖 Claude';
    const date = new Date(m.timestamp).toLocaleString('zh-CN');
    return `${i + 1}. ${roleLabel}  [${date}]\n   ${m.summary}`;
  });

  return header + lines.join('\n\n');
}

/** 会话元信息（降级方案：无法读取消息记录时展示） */
export interface SessionMetaInfo {
  readonly sessionId: string;
  readonly summary: string;
  readonly firstPrompt?: string;
  readonly lastModified: number;
}

/** 将会话元信息格式化为飞书文本（降级方案） */
export function formatSessionInfo(session: SessionMetaInfo): string {
  const date = new Date(session.lastModified).toLocaleString('zh-CN');
  const shortId = session.sessionId.slice(0, 12);
  const title = session.summary || session.firstPrompt?.slice(0, 60) || '(无标题)';

  const lines = [
    '当前会话信息：',
    '',
    `ID: ${shortId}...`,
    `标题: ${title}`,
    `最后活跃: ${date}`,
  ];

  if (session.firstPrompt) {
    const preview = session.firstPrompt.length > 80
      ? session.firstPrompt.slice(0, 80) + '...'
      : session.firstPrompt;
    lines.push(`首条提问: ${preview}`);
  }

  return lines.join('\n');
}

/** 将文本截断到指定长度，超长时追加省略号 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
