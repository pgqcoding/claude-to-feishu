import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/session-manager.js';
import { Store } from '../../src/core/store.js';
import type { SessionInfo } from '../../src/types.js';

describe('SessionManager', () => {
  let tmpDir: string;
  let store: Store;
  let manager: SessionManager;
  const mockBridge = {
    listProjectSessions: vi.fn<any>(),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-sm-'));
    store = new Store(path.join(tmpDir, 'state.json'));
    manager = new SessionManager({
      store,
      bridge: mockBridge as any,
      allowedDirs: ['/work/project-a', '/work/project-b'],
      dirAliases: new Map([['a', '/work/project-a']]),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists sessions from allowed dirs', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'session 1', lastModified: Date.now(), cwd: '/work/project-a' },
      { sessionId: 's2', summary: 'session 2', lastModified: Date.now() - 1000, cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    const result = await manager.listSessions();
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('switches to session by index', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'session 1', lastModified: Date.now(), cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    await manager.listSessions();
    const binding = await manager.switchSession('1');
    expect(binding.sessionId).toBe('s1');
  });

  it('switches to session by id', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'session 1', lastModified: Date.now(), cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    await manager.listSessions();
    const binding = await manager.switchSession('s1');
    expect(binding.sessionId).toBe('s1');
  });

  it('rejects switch to non-existent session', async () => {
    mockBridge.listProjectSessions.mockResolvedValue([]);
    await manager.listSessions();
    await expect(manager.switchSession('999')).rejects.toThrow();
  });

  it('resolves alias to directory', () => {
    expect(manager.resolveAlias('a')).toBe('/work/project-a');
    expect(manager.resolveAlias('unknown')).toBeNull();
  });

  it('TTL 内再次调用 listSessions 直接返回缓存，不调用 bridge', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'session 1', lastModified: Date.now(), cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    // 第一次调用，触发真实查询
    await manager.listSessions();
    const callCountAfterFirst = mockBridge.listProjectSessions.mock.calls.length;

    // TTL 未过期，第二次应命中缓存，不再调用 bridge
    await manager.listSessions();
    expect(mockBridge.listProjectSessions.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('forceRefresh=true 时跳过 TTL 强制重新查询', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'session 1', lastModified: Date.now(), cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    await manager.listSessions();
    const callCountAfterFirst = mockBridge.listProjectSessions.mock.calls.length;

    // 强制刷新，应再次调用 bridge
    await manager.listSessions(true);
    expect(mockBridge.listProjectSessions.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
  });

  it('persists binding across load/save', async () => {
    const fakeSessions: SessionInfo[] = [
      { sessionId: 's1', summary: 'test', lastModified: Date.now(), cwd: '/work/project-a' },
    ];
    mockBridge.listProjectSessions.mockResolvedValue(fakeSessions);

    await manager.listSessions();
    await manager.switchSession('s1');

    const manager2 = new SessionManager({
      store,
      bridge: mockBridge as any,
      allowedDirs: ['/work/project-a'],
      dirAliases: new Map(),
    });
    const binding = await manager2.getCurrentBinding();
    expect(binding?.sessionId).toBe('s1');
  });
});
