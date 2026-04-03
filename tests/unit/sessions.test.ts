import { describe, it, expect } from 'vitest';
import { formatSessions } from '../../src/feishu/commands/sessions.js';
import type { SessionInfo, SessionBinding } from '../../src/types.js';

const baseSession: SessionInfo = {
  sessionId: 'abcdef1234567890',
  summary: '修复登录 Bug',
  lastModified: new Date('2024-01-15T10:30:00').getTime(),
  cwd: '/work/myproject',
};

const binding: SessionBinding = {
  sessionId: 'abcdef1234567890',
  projectDir: '/work/myproject',
  projectAlias: 'myproject',
  boundAt: Date.now(),
};

describe('formatSessions', () => {
  it('空列表返回提示文案', () => {
    const result = formatSessions({ sessions: [], currentBinding: null });
    expect(result).toContain('暂无可用会话');
    expect(result).toContain('/new');
  });

  it('有会话但无绑定 → 所有条目均无 ▶ 标记', () => {
    const result = formatSessions({ sessions: [baseSession], currentBinding: null });
    expect(result).toContain('修复登录 Bug');
    expect(result).not.toContain('▶');
    // 序号显示
    expect(result).toContain('1.');
  });

  it('当前绑定会话显示 ▶ 标记', () => {
    const result = formatSessions({ sessions: [baseSession], currentBinding: binding });
    expect(result).toContain('▶');
    expect(result).toContain('修复登录 Bug');
  });

  it('非当前会话不显示 ▶ 标记（多会话场景）', () => {
    const other: SessionInfo = {
      ...baseSession,
      sessionId: 'other-session-id',
      summary: '其他会话',
    };
    const result = formatSessions({ sessions: [baseSession, other], currentBinding: binding });
    // 当前会话有标记
    expect(result).toContain('▶');
    // 两条会话均列出
    expect(result).toContain('修复登录 Bug');
    expect(result).toContain('其他会话');
  });

  it('显示 git 分支信息', () => {
    const withBranch: SessionInfo = { ...baseSession, gitBranch: 'feat/new-feature' };
    const result = formatSessions({ sessions: [withBranch], currentBinding: null });
    expect(result).toContain('[feat/new-feature]');
  });

  it('无 git 分支时不显示分支标记', () => {
    const result = formatSessions({ sessions: [baseSession], currentBinding: null });
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
  });

  it('显示 sessionId 前 8 位', () => {
    const result = formatSessions({ sessions: [baseSession], currentBinding: null });
    expect(result).toContain('ID: abcdef12');
    // 不应显示完整 ID
    expect(result).not.toContain('abcdef1234567890');
  });

  it('标题优先级：customTitle > summary > firstPrompt > 无标题', () => {
    const withCustomTitle: SessionInfo = { ...baseSession, customTitle: '自定义标题' };
    const r1 = formatSessions({ sessions: [withCustomTitle], currentBinding: null });
    expect(r1).toContain('自定义标题');

    const withPromptOnly: SessionInfo = {
      sessionId: 'id-only-prompt',
      summary: '',
      lastModified: Date.now(),
      cwd: '/work',
      firstPrompt: '帮我写个排序算法',
    };
    const r2 = formatSessions({ sessions: [withPromptOnly], currentBinding: null });
    expect(r2).toContain('帮我写个排序算法');

    const noTitle: SessionInfo = {
      sessionId: 'no-title-session',
      summary: '',
      lastModified: Date.now(),
      cwd: '/work',
    };
    const r3 = formatSessions({ sessions: [noTitle], currentBinding: null });
    expect(r3).toContain('(无标题)');
  });

  it('底部包含操作提示', () => {
    const result = formatSessions({ sessions: [baseSession], currentBinding: null });
    expect(result).toContain('/switch');
    expect(result).toContain('/sessions refresh');
  });
});
