import { describe, it, expect } from 'vitest';
import {
  formatHistory,
  formatSessionInfo,
  truncate,
} from '../../src/feishu/commands/history.js';
import type { MessageRecord, SessionMetaInfo } from '../../src/feishu/commands/history.js';

describe('formatHistory', () => {
  it('空消息列表时返回提示语', () => {
    const result = formatHistory([]);
    expect(result).toContain('暂无历史消息');
  });

  it('单条用户消息格式正确', () => {
    const messages: MessageRecord[] = [
      { uuid: 'uuid-1', role: 'user', summary: '帮我看看这个 bug', timestamp: 1700000000000 },
    ];
    const result = formatHistory(messages);
    expect(result).toContain('1.');
    expect(result).toContain('用户');
    expect(result).toContain('帮我看看这个 bug');
  });

  it('单条 assistant 消息显示 Claude 标签', () => {
    const messages: MessageRecord[] = [
      { uuid: 'uuid-2', role: 'assistant', summary: '这是回复内容', timestamp: 1700000001000 },
    ];
    const result = formatHistory(messages);
    expect(result).toContain('Claude');
    expect(result).toContain('这是回复内容');
  });

  it('多条消息包含序号', () => {
    const messages: MessageRecord[] = [
      { uuid: 'a', role: 'user', summary: '第一条', timestamp: 1700000000000 },
      { uuid: 'b', role: 'assistant', summary: '第二条', timestamp: 1700000001000 },
      { uuid: 'c', role: 'user', summary: '第三条', timestamp: 1700000002000 },
    ];
    const result = formatHistory(messages);
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('3.');
    expect(result).toContain('最近 3 条');
  });

  it('消息数量标题显示正确', () => {
    const messages: MessageRecord[] = Array.from({ length: 5 }, (_, i) => ({
      uuid: `uuid-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      summary: `消息 ${i}`,
      timestamp: 1700000000000 + i * 1000,
    }));
    const result = formatHistory(messages);
    expect(result).toContain('最近 5 条');
  });
});

describe('formatSessionInfo', () => {
  it('完整字段时格式化正确', () => {
    const session: SessionMetaInfo = {
      sessionId: 'abcdef123456789012',
      summary: '项目调试会话',
      firstPrompt: '帮我分析一下这段代码',
      lastModified: 1700000000000,
    };
    const result = formatSessionInfo(session);
    expect(result).toContain('abcdef123456');
    expect(result).toContain('项目调试会话');
    expect(result).toContain('帮我分析一下这段代码');
    expect(result).toContain('当前会话信息');
  });

  it('sessionId 只显示前 12 字符加省略号', () => {
    const session: SessionMetaInfo = {
      sessionId: 'xxxxxxxxxxxxxxxxxxx',
      summary: '测试',
      lastModified: 1700000000000,
    };
    const result = formatSessionInfo(session);
    expect(result).toContain('xxxxxxxxxxxx...');
    // 不包含完整 ID
    expect(result).not.toContain('xxxxxxxxxxxxxxxxxxx');
  });

  it('没有 firstPrompt 时不显示首条提问行', () => {
    const session: SessionMetaInfo = {
      sessionId: 'sess-no-prompt',
      summary: '会话摘要',
      lastModified: 1700000000000,
    };
    const result = formatSessionInfo(session);
    expect(result).not.toContain('首条提问');
  });

  it('firstPrompt 超过 80 字符时截断', () => {
    const longPrompt = 'a'.repeat(100);
    const session: SessionMetaInfo = {
      sessionId: 'sess-long',
      summary: '测试',
      firstPrompt: longPrompt,
      lastModified: 1700000000000,
    };
    const result = formatSessionInfo(session);
    // 截断后不超过 80+3（省略号）字符
    const promptLine = result.split('\n').find(l => l.includes('首条提问'));
    expect(promptLine).toBeDefined();
    // 80 个 a 加上 ...
    expect(promptLine).toContain('a'.repeat(80) + '...');
  });

  it('summary 为空时降级使用 firstPrompt', () => {
    const session: SessionMetaInfo = {
      sessionId: 'sess-no-summary',
      summary: '',
      firstPrompt: '这是第一个问题',
      lastModified: 1700000000000,
    };
    const result = formatSessionInfo(session);
    expect(result).toContain('这是第一个问题');
  });
});

describe('truncate', () => {
  it('短于限制时原样返回', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('等于限制时原样返回', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('超出限制时截断并加省略号', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('限制为 0 时返回省略号', () => {
    expect(truncate('abc', 0)).toBe('...');
  });
});
