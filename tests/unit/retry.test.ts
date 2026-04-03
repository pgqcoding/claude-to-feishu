import { describe, it, expect, beforeEach } from 'vitest';
import { RetryStore } from '../../src/feishu/commands/index.js';
import type { LastQuery } from '../../src/feishu/commands/index.js';

function makeQuery(overrides: Partial<LastQuery> = {}): LastQuery {
  return {
    prompt: '帮我查询一下',
    chatId: 'chat_1',
    sessionId: 'sess-1',
    projectDir: '/work/proj',
    success: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('RetryStore', () => {
  let store: RetryStore;

  beforeEach(() => {
    store = new RetryStore();
  });

  it('record + getRetryable：失败查询可重试', () => {
    const query = makeQuery({ success: false });
    store.record(query);
    expect(store.getRetryable('chat_1')).toEqual(query);
  });

  it('getRetryable：成功查询不可重试，返回 null', () => {
    const query = makeQuery({ success: true });
    store.record(query);
    expect(store.getRetryable('chat_1')).toBeNull();
  });

  it('clear 后 getRetryable 返回 null', () => {
    store.record(makeQuery({ success: false }));
    store.clear('chat_1');
    expect(store.getRetryable('chat_1')).toBeNull();
  });

  it('多个 chatId 互相隔离', () => {
    store.record(makeQuery({ chatId: 'chat_1', success: false, prompt: 'query-1' }));
    store.record(makeQuery({ chatId: 'chat_2', success: true, prompt: 'query-2' }));

    const r1 = store.getRetryable('chat_1');
    expect(r1?.prompt).toBe('query-1');

    // chat_2 成功，不可重试
    expect(store.getRetryable('chat_2')).toBeNull();
  });

  it('新记录覆盖旧记录', () => {
    store.record(makeQuery({ prompt: '旧查询', success: false }));
    store.record(makeQuery({ prompt: '新查询', success: false }));
    expect(store.getRetryable('chat_1')?.prompt).toBe('新查询');
  });

  it('失败记录被成功记录覆盖后不可重试', () => {
    store.record(makeQuery({ prompt: '失败查询', success: false }));
    store.record(makeQuery({ prompt: '成功查询', success: true }));
    expect(store.getRetryable('chat_1')).toBeNull();
  });

  it('未记录任何查询时 getRetryable 返回 null', () => {
    expect(store.getRetryable('chat_unknown')).toBeNull();
  });

  it('clear 不存在的 chatId 不抛出异常', () => {
    expect(() => store.clear('chat_nonexistent')).not.toThrow();
  });
});
