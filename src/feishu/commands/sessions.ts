import type { SessionInfo, SessionBinding } from '../../types.js';

interface FormatOptions {
  readonly sessions: readonly SessionInfo[];
  readonly currentBinding: SessionBinding | null;
}

/**
 * 格式化增强版会话列表
 * - 当前绑定会话用 ▶ 标记
 * - 显示 git 分支、sessionId 前 8 位
 * - 底部显示操作提示
 */
export function formatSessions(options: FormatOptions): string {
  const { sessions, currentBinding } = options;
  if (sessions.length === 0) {
    return '暂无可用会话。请先在 CLI 中创建会话，或用 /new 创建。';
  }

  let text = '📋 会话列表：\n\n';
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const isCurrent = currentBinding?.sessionId === s.sessionId;
    const marker = isCurrent ? '▶' : ' ';
    const title = s.customTitle || s.summary || s.firstPrompt?.slice(0, 50) || '(无标题)';
    const date = new Date(s.lastModified).toLocaleString('zh-CN');
    const branch = s.gitBranch ? ` [${s.gitBranch}]` : '';
    const idPrefix = s.sessionId.slice(0, 8);

    text += `${marker} ${i + 1}. ${title}\n`;
    text += `   ${date} | ${s.cwd}${branch}\n`;
    text += `   ID: ${idPrefix}\n\n`;
  }

  text += '操作：/switch <序号> 切换 | /resume <ID前缀> 恢复 | /sessions refresh 刷新';
  return text;
}
