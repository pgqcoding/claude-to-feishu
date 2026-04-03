import { describe, it, expect } from 'vitest';
import { buildForkPrompt, formatForkSuccess } from '../../src/feishu/commands/fork.js';
import type { ForkParams } from '../../src/feishu/commands/fork.js';

const baseParams: ForkParams = {
  currentSessionId: 'abcd1234efgh5678',
  projectDir: '/home/user/project',
  projectAlias: 'my-project',
};

describe('buildForkPrompt', () => {
  it('包含当前 sessionId', () => {
    const prompt = buildForkPrompt(baseParams);
    expect(prompt).toContain('abcd1234efgh5678');
  });

  it('包含上下文延续说明', () => {
    const prompt = buildForkPrompt(baseParams);
    expect(prompt).toContain('继续');
  });

  it('返回字符串类型', () => {
    const prompt = buildForkPrompt(baseParams);
    expect(typeof prompt).toBe('string');
  });

  it('prompt 格式稳定（快照式验证）', () => {
    const prompt = buildForkPrompt(baseParams);
    expect(prompt).toBe('继续之前的对话。上一个会话 ID: abcd1234efgh5678');
  });

  it('长 sessionId 也能正确包含', () => {
    const params: ForkParams = {
      ...baseParams,
      currentSessionId: 'a'.repeat(64),
    };
    const prompt = buildForkPrompt(params);
    expect(prompt).toContain('a'.repeat(64));
  });

  it('多次调用结果相同（幂等性）', () => {
    const first = buildForkPrompt(baseParams);
    const second = buildForkPrompt(baseParams);
    expect(first).toBe(second);
  });

  it('特殊字符 sessionId 不被截断或转义', () => {
    const params: ForkParams = {
      ...baseParams,
      currentSessionId: 'abc-123_def.456',
    };
    const prompt = buildForkPrompt(params);
    expect(prompt).toContain('abc-123_def.456');
  });
});

describe('formatForkSuccess', () => {
  it('包含项目别名', () => {
    const msg = formatForkSuccess(baseParams);
    expect(msg).toContain('my-project');
  });

  it('包含 sessionId 前 8 位', () => {
    const msg = formatForkSuccess(baseParams);
    expect(msg).toContain('abcd1234');
  });

  it('返回字符串类型', () => {
    const msg = formatForkSuccess(baseParams);
    expect(typeof msg).toBe('string');
  });

  it('完整 sessionId 不出现在输出中（只取前缀）', () => {
    const msg = formatForkSuccess(baseParams);
    // 完整 16 字符 id 不应出现
    expect(msg).not.toContain('abcd1234efgh5678');
    expect(msg).toContain('abcd1234');
  });

  it('空别名时使用占位文本', () => {
    const params: ForkParams = { ...baseParams, projectAlias: '' };
    const msg = formatForkSuccess(params);
    expect(msg).toContain('(未命名)');
  });

  it('长 sessionId 时仍只显示前 8 位', () => {
    const params: ForkParams = {
      ...baseParams,
      currentSessionId: 'a'.repeat(64),
    };
    const msg = formatForkSuccess(params);
    expect(msg).toContain('a'.repeat(8));
    // 不包含第 9 位以后的内容（全是 'a' 所以看字数）
    expect(msg).not.toContain('a'.repeat(9));
  });

  it('多次调用结果相同（幂等性）', () => {
    const first = formatForkSuccess(baseParams);
    const second = formatForkSuccess(baseParams);
    expect(first).toBe(second);
  });
});
