import type { SessionInfo } from '../../types.js';

/** resolveSession 的返回类型 */
export interface ResumeResult {
  readonly success: boolean;
  readonly message: string;
}

/** 携带 sessionId 的成功结果 */
export interface ResumeSuccess extends ResumeResult {
  readonly success: true;
  readonly sessionId: string;
}

/** 失败结果 */
export interface ResumeFailure extends ResumeResult {
  readonly success: false;
  readonly sessionId?: undefined;
}

/** resolveSession 联合返回类型 */
export type ResolveResult = ResumeSuccess | ResumeFailure;

/**
 * 根据查询字符串从会话列表中定位目标会话
 *
 * 支持两种查询模式：
 * 1. 序号：纯数字，从 1 开始
 * 2. sessionId 前缀：至少 4 字符，大小写不敏感
 */
export function resolveSession(
  sessions: readonly SessionInfo[],
  query: string,
): ResolveResult {
  // 空查询
  const trimmed = query.trim();
  if (!trimmed) {
    return { success: false, message: '请提供会话 ID 前缀或序号' };
  }

  // 序号匹配：纯数字
  if (/^\d+$/.test(trimmed)) {
    const index = parseInt(trimmed, 10) - 1;
    if (index < 0 || index >= sessions.length) {
      return {
        success: false,
        message: `序号 ${trimmed} 超出范围（共 ${sessions.length} 个会话）`,
      };
    }
    const session = sessions[index];
    return { success: true, sessionId: session.sessionId, message: '' };
  }

  // 前缀匹配：至少 4 字符
  if (trimmed.length < 4) {
    return { success: false, message: '前缀至少需要 4 个字符以避免歧义' };
  }

  const lowerQuery = trimmed.toLowerCase();
  const matched = sessions.filter(s =>
    s.sessionId.toLowerCase().startsWith(lowerQuery),
  );

  if (matched.length === 0) {
    return { success: false, message: `未找到 sessionId 前缀为 "${trimmed}" 的会话` };
  }

  if (matched.length > 1) {
    const ids = matched.map(s => s.sessionId.slice(0, 8)).join(', ');
    return {
      success: false,
      message: `前缀 "${trimmed}" 匹配到 ${matched.length} 个会话：${ids}，请提供更长前缀`,
    };
  }

  return { success: true, sessionId: matched[0].sessionId, message: '' };
}
