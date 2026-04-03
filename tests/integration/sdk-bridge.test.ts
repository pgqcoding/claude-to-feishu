import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkBridge } from '../../src/core/sdk-bridge.js';
import type { SdkFunctions } from '../../src/core/sdk-bridge.js';

const mockQuery = vi.fn();
const mockListSessions = vi.fn();

const mockSdk: SdkFunctions = {
  query: mockQuery,
  listSessions: mockListSessions,
};

describe('SdkBridge', () => {
  let bridge: SdkBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new SdkBridge({
      defaultModel: 'sonnet',
      defaultMode: 'code',
      maxConcurrentQueries: 3,
      queryTimeoutMs: 5000,
      sdk: mockSdk,
    });
  });

  describe('listProjectSessions', () => {
    it('returns mapped session info', async () => {
      mockListSessions.mockResolvedValue([
        {
          sessionId: 'sess-1',
          summary: 'test session',
          lastModified: Date.now(),
          fileSize: 1024,
          cwd: '/work/project',
          gitBranch: 'main',
        },
      ]);
      const sessions = await bridge.listProjectSessions('/work/project');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-1');
      expect(sessions[0].summary).toBe('test session');
    });
  });

  describe('sendQuery', () => {
    it('collects text from async generator', async () => {
      async function* fakeGenerator() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } };
      }
      mockQuery.mockReturnValue(fakeGenerator() as any);

      const result = await bridge.sendQuery({
        prompt: 'hi',
        cwd: '/work/project',
      });
      expect(result.text).toBe('Hello World');
      expect(result.success).toBe(true);
    });

    it('rejects when max concurrent queries reached', async () => {
      bridge = new SdkBridge({
        defaultModel: 'sonnet',
        defaultMode: 'code',
        maxConcurrentQueries: 1,
        queryTimeoutMs: 5000,
        sdk: mockSdk,
      });

      let resolveQuery: () => void;
      const blockingPromise = new Promise<void>(r => { resolveQuery = r; });
      async function* slowGenerator() {
        await blockingPromise;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      }
      mockQuery.mockReturnValue(slowGenerator() as any);

      const q1 = bridge.sendQuery({ prompt: 'first', cwd: '/work' });
      expect(bridge.activeQueryCount).toBe(1);

      resolveQuery!();
      await q1;
    });
  });

  describe('abort', () => {
    it('aborts running query for session', async () => {
      async function* abortableGenerator() {
        await new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('aborted'));
          }, 100);
        });
      }
      mockQuery.mockReturnValue(abortableGenerator() as any);

      const resultPromise = bridge.sendQuery({
        prompt: 'hi',
        cwd: '/work',
        sessionId: 'sess-abort',
      });

      bridge.abortSession('sess-abort');

      const result = await resultPromise;
      expect(result.success).toBe(false);
    });
  });
});
