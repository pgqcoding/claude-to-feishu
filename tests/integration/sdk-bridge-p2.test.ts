import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanUseToolCallback, StreamQueryOptions } from '../../src/core/sdk-bridge.js';

/**
 * SdkBridge Phase 2 集成测试
 * 验证 queryStream 的行为：canUseTool 回调、onChunk 事件转发、文本提取
 */

describe('SdkBridge Phase 2: queryStream', () => {
  describe('canUseTool callback forwarding', () => {
    it('calls canUseTool when SDK requests tool use', async () => {
      const canUseTool: CanUseToolCallback = vi.fn(async () => ({ behavior: 'allow' as const }));

      const result = await canUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool_test_1',
      });

      expect(canUseTool).toHaveBeenCalledTimes(1);
      expect(canUseTool).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        expect.objectContaining({ toolUseID: 'tool_test_1' })
      );
      expect(result.behavior).toBe('allow');
    });

    it('deny behavior is propagated correctly', async () => {
      const canUseTool: CanUseToolCallback = vi.fn(async () => ({
        behavior: 'deny' as const,
        message: '用户拒绝',
      }));

      const result = await canUseTool('Write', { file_path: '/tmp/x' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool_test_2',
      });

      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toBe('用户拒绝');
    });

    it('allow with updatedInput passes updated input through', async () => {
      const updatedInput = { command: 'ls -la' };
      const canUseTool: CanUseToolCallback = vi.fn(async () => ({
        behavior: 'allow' as const,
        updatedInput,
      }));

      const result = await canUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool_test_3',
      });

      expect(result.behavior).toBe('allow');
      expect((result as { behavior: 'allow'; updatedInput?: Record<string, unknown> }).updatedInput).toEqual(updatedInput);
    });
  });

  describe('StreamQueryOptions interface', () => {
    it('StreamQueryOptions has required fields', () => {
      const opts: StreamQueryOptions = {
        prompt: 'test',
        cwd: '/tmp',
        onChunk: (chunk: string) => { void chunk; },
        canUseTool: async () => ({ behavior: 'allow' as const }),
        abortController: new AbortController(),
      };

      expect(opts.prompt).toBe('test');
      expect(opts.cwd).toBe('/tmp');
      expect(typeof opts.onChunk).toBe('function');
      expect(typeof opts.canUseTool).toBe('function');
      expect(opts.abortController).toBeInstanceOf(AbortController);
    });

    it('sessionId is optional', () => {
      const withSession: StreamQueryOptions = {
        prompt: 'hello',
        cwd: '/tmp',
        sessionId: 'sess_abc123',
      };

      const withoutSession: StreamQueryOptions = {
        prompt: 'hello',
        cwd: '/tmp',
      };

      expect(withSession.sessionId).toBe('sess_abc123');
      expect(withoutSession.sessionId).toBeUndefined();
    });
  });

  describe('chunk extraction', () => {
    // 提取逻辑镜像 sdk-bridge.ts 中的 extractText 私有方法
    const extractText = (msg: unknown): string | null => {
      if (!msg || typeof msg !== 'object') return null;
      const m = msg as Record<string, unknown>;

      // 格式1: { type: 'assistant', message: { content: [...] } }
      if (m['type'] === 'assistant') {
        const message = m['message'] as Record<string, unknown> | undefined;
        if (message && Array.isArray(message['content'])) {
          const parts = (message['content'] as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '');
          return parts.length > 0 ? parts.join('') : null;
        }
      }

      // 格式2: { result_text: '...' }
      if (typeof m['result_text'] === 'string') return m['result_text'];

      return null;
    };

    it('extracts text from assistant message format', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        },
      };

      expect(extractText(event)).toBe('Hello World');
    });

    it('extracts text from result_text event format', () => {
      const event = { result_text: 'Final answer' };
      expect(extractText(event)).toBe('Final answer');
    });

    it('ignores non-text content blocks', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool_xyz' },
            { type: 'text', text: 'Done' },
          ],
        },
      };

      expect(extractText(event)).toBe('Done');
    });

    it('returns null when assistant message has no text blocks', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool_abc' }],
        },
      };

      expect(extractText(event)).toBeNull();
    });

    it('returns null for unknown message types', () => {
      expect(extractText({ type: 'tool_result', id: 'xyz' })).toBeNull();
      expect(extractText(null)).toBeNull();
      expect(extractText('string')).toBeNull();
      expect(extractText(42)).toBeNull();
    });
  });

  describe('queryStream with mock SDK', () => {
    it('accumulates chunks and calls onChunk for each assistant event', async () => {
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      const events = [
        { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '世界' }] } },
        { result_text: '你好世界' },
      ];

      async function* mockGenerator() {
        for (const e of events) yield e;
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      const chunks: string[] = [];
      const result = await bridge.queryStream({
        prompt: 'test prompt',
        cwd: '/tmp',
        onChunk: (chunk) => chunks.push(chunk),
      });

      // 最终返回值是所有文本块累加的结果
      expect(result).toBe('你好世界你好世界');
      // onChunk 被调用了3次（两次 assistant + 一次 result_text）
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toBe('你好');
      expect(chunks[1]).toBe('世界');
      expect(chunks[2]).toBe('你好世界');
    });

    it('passes canUseTool to SDK query options', async () => {
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      async function* mockGenerator() {
        yield { result_text: 'ok' };
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      const canUseTool: CanUseToolCallback = vi.fn(async () => ({ behavior: 'allow' as const }));

      await bridge.queryStream({
        prompt: 'test',
        cwd: '/tmp',
        canUseTool,
      });

      expect(mockSdk.query).toHaveBeenCalledTimes(1);
      const callArg = mockSdk.query.mock.calls[0][0] as Record<string, unknown>;
      const queryOpts = callArg['options'] as Record<string, unknown>;
      expect(queryOpts['canUseTool']).toBe(canUseTool);
    });

    it('does not include canUseTool in options when not provided', async () => {
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      async function* mockGenerator() {
        yield { result_text: 'ok' };
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });

      const callArg = mockSdk.query.mock.calls[0][0] as Record<string, unknown>;
      const queryOpts = callArg['options'] as Record<string, unknown>;
      expect(queryOpts['canUseTool']).toBeUndefined();
    });

    it('respects abort signal and stops iteration', async () => {
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      const controller = new AbortController();

      async function* mockGenerator() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk1' }] } };
        // 在第一个事件后中止
        controller.abort();
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk2' }] } };
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      const chunks: string[] = [];
      await bridge.queryStream({
        prompt: 'test',
        cwd: '/tmp',
        onChunk: (c) => chunks.push(c),
        abortController: controller,
      });

      // 中止后不再处理后续 chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('chunk1');
    });

    it('decrements activeQueryCount after completion', async () => {
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      async function* mockGenerator() {
        yield { result_text: 'done' };
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      expect(bridge.activeQueryCount).toBe(0);
      await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });
      expect(bridge.activeQueryCount).toBe(0);
    });

    it('多 chunk 场景下 fullText 正确累加而非覆盖', async () => {
      // 验证缺陷1修复：三个独立文本块应拼接，而非只保留最后一个
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      async function* mockGenerator() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk-A ' }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk-B ' }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk-C' }] } };
      }

      const mockSdk = {
        query: vi.fn(() => mockGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      const result = await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });
      // 应累加所有 chunk，而不是只返回最后一个 'chunk-C'
      expect(result).toBe('chunk-A chunk-B chunk-C');
    });

    it('generator 抛出错误时 activeQueryCount 正确递减', async () => {
      // 异常路径：generator 中途抛错，finally 应确保计数归零
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      async function* failingGenerator() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
        throw new Error('generator 内部错误');
      }

      const mockSdk = {
        query: vi.fn(() => failingGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      expect(bridge.activeQueryCount).toBe(0);
      // queryStream 不捕获 generator 错误，应向上抛出
      await expect(
        bridge.queryStream({ prompt: 'test', cwd: '/tmp' })
      ).rejects.toThrow('generator 内部错误');
      // 即使异常，计数应归零
      expect(bridge.activeQueryCount).toBe(0);
    });

    it('getSdk() 抛出异常时 activeQueryCount 正确递减', async () => {
      // 异常路径：getSdk 本身失败（动态 import 出错），finally 应确保计数归零
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      // 不传入 sdk，让 SdkBridge 走 getSdk() 路径；但通过构造后替换私有字段模拟失败
      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 5,
        queryTimeoutMs: 30000,
      });

      // 用 Object.defineProperty 拦截私有方法（利用 JS 反射绕过 TS 访问限制）
      const bridgeAny = bridge as unknown as Record<string, unknown>;
      bridgeAny['getSdk'] = async () => {
        throw new Error('SDK 加载失败');
      };

      expect(bridge.activeQueryCount).toBe(0);
      await expect(
        bridge.queryStream({ prompt: 'test', cwd: '/tmp' })
      ).rejects.toThrow('SDK 加载失败');
      // getSdk 失败后 finally 应递减计数
      expect(bridge.activeQueryCount).toBe(0);
    });

    it('并发超限时 queryStream 抛出错误', async () => {
      // 验证缺陷2修复：流式查询也受并发上限保护
      const { SdkBridge } = await import('../../src/core/sdk-bridge.js');

      let unblock: () => void;
      const blockPromise = new Promise<void>(r => { unblock = r; });

      async function* slowGenerator() {
        await blockPromise;
        yield { result_text: 'done' };
      }

      const mockSdk = {
        query: vi.fn(() => slowGenerator()),
        listSessions: vi.fn(async () => []),
      };

      const bridge = new SdkBridge({
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMode: 'auto',
        maxConcurrentQueries: 1,  // 上限设为 1
        queryTimeoutMs: 30000,
        sdk: mockSdk,
      });

      // 启动第一个查询（占用唯一名额）
      const first = bridge.queryStream({ prompt: 'first', cwd: '/tmp' });
      expect(bridge.activeQueryCount).toBe(1);

      // 第二个查询应立即被拒绝
      await expect(
        bridge.queryStream({ prompt: 'second', cwd: '/tmp' })
      ).rejects.toThrow('已达到最大并发查询数');

      // 释放第一个查询，确保计数归零
      unblock!();
      await first;
      expect(bridge.activeQueryCount).toBe(0);
    });
  });
});
