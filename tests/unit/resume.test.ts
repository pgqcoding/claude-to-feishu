import { describe, it, expect } from 'vitest';
import { resolveSession } from '../../src/feishu/commands/resume.js';
import type { SessionInfo } from '../../src/types.js';

/** 构造测试用的 SessionInfo */
function makeSession(overrides: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return {
    summary: '测试会话',
    lastModified: Date.now(),
    cwd: '/tmp/test',
    ...overrides,
  };
}

const sessions: readonly SessionInfo[] = [
  makeSession({ sessionId: 'abcd1234efgh5678' }),
  makeSession({ sessionId: 'wxyz9876mnop4321' }),
  makeSession({ sessionId: 'abcd9999xxxx0000' }),
];

describe('resolveSession', () => {
  it('序号 "1" 匹配第一个会话', () => {
    const result = resolveSession(sessions, '1');
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('abcd1234efgh5678');
  });

  it('序号 "2" 匹配第二个会话', () => {
    const result = resolveSession(sessions, '2');
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('wxyz9876mnop4321');
  });

  it('序号超出范围（序号 99）返回失败', () => {
    const result = resolveSession(sessions, '99');
    expect(result.success).toBe(false);
    expect(result.message).toContain('超出范围');
  });

  it('sessionId 前缀唯一匹配成功', () => {
    // wxyz 只有一个
    const result = resolveSession(sessions, 'wxyz');
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('wxyz9876mnop4321');
  });

  it('sessionId 前缀匹配多个时返回歧义错误', () => {
    // "abcd" 匹配两个会话
    const result = resolveSession(sessions, 'abcd');
    expect(result.success).toBe(false);
    expect(result.message).toContain('匹配到');
    expect(result.message).toContain('2');
  });

  it('前缀少于 4 字符时返回错误', () => {
    const result = resolveSession(sessions, 'ab');
    expect(result.success).toBe(false);
    expect(result.message).toContain('4');
  });

  it('前缀无匹配时返回错误', () => {
    const result = resolveSession(sessions, 'zzzz');
    expect(result.success).toBe(false);
    expect(result.message).toContain('未找到');
  });

  it('空查询字符串返回错误', () => {
    const result = resolveSession(sessions, '');
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('大小写不敏感匹配（大写前缀）', () => {
    const result = resolveSession(sessions, 'WXYZ');
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('wxyz9876mnop4321');
  });

  it('完整 sessionId 匹配成功', () => {
    const result = resolveSession(sessions, 'wxyz9876mnop4321');
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('wxyz9876mnop4321');
  });

  it('序号 "0" 超出范围返回失败', () => {
    const result = resolveSession(sessions, '0');
    expect(result.success).toBe(false);
    expect(result.message).toContain('超出范围');
  });

  it('仅空白字符的查询视为空查询', () => {
    const result = resolveSession(sessions, '   ');
    expect(result.success).toBe(false);
  });

  it('空会话列表时序号查询返回失败', () => {
    const result = resolveSession([], '1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('超出范围');
  });

  it('空会话列表时前缀查询返回未找到', () => {
    const result = resolveSession([], 'abcd');
    expect(result.success).toBe(false);
    expect(result.message).toContain('未找到');
  });
});
