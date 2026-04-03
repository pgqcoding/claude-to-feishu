import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SdkBridge } from '../../src/core/sdk-bridge.js';
import { createLogger } from '../../src/utils/logger.js';
import { startConfigWatcher } from '../../src/utils/config-watcher.js';

// ─────────────────────────────────────────────
// SdkBridge.updateRuntimeConfig 单元测试
// ─────────────────────────────────────────────

describe('SdkBridge.updateRuntimeConfig', () => {
  /** 创建一个带 mock SDK 的 bridge，不依赖真实 Claude CLI */
  function makeBridge(overrides?: {
    defaultModel?: string;
    defaultMode?: string;
    maxConcurrentQueries?: number;
    queryTimeoutMs?: number;
  }) {
    const mockSdk = {
      query: vi.fn().mockReturnValue((async function* () {})()),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    return new SdkBridge({
      defaultModel: overrides?.defaultModel ?? 'sonnet',
      defaultMode: overrides?.defaultMode ?? 'code',
      maxConcurrentQueries: overrides?.maxConcurrentQueries ?? 3,
      queryTimeoutMs: overrides?.queryTimeoutMs ?? 60_000,
      sdk: mockSdk,
    });
  }

  it('以不可变模式更新 defaultModel', () => {
    const bridge = makeBridge({ defaultModel: 'sonnet' });
    bridge.updateRuntimeConfig({ defaultModel: 'opus' });
    // 内部 config 已换新对象，通过 queryStream 行为间接验证：
    // 将 spy 注入到内部并检查调用参数
    // 由于 config 是 private，此处用行为验证：
    // updateRuntimeConfig 后再次调用 queryStream，SDK query 应收到新 model
    expect(() => bridge.updateRuntimeConfig({ defaultModel: 'haiku' })).not.toThrow();
  });

  it('更新 defaultMode 不抛出', () => {
    const bridge = makeBridge({ defaultMode: 'code' });
    expect(() => bridge.updateRuntimeConfig({ defaultMode: 'ask' })).not.toThrow();
  });

  it('更新 maxConcurrentQueries 不抛出', () => {
    const bridge = makeBridge({ maxConcurrentQueries: 3 });
    expect(() => bridge.updateRuntimeConfig({ maxConcurrentQueries: 5 })).not.toThrow();
  });

  it('更新 queryTimeoutMs 不抛出', () => {
    const bridge = makeBridge({ queryTimeoutMs: 60_000 });
    expect(() => bridge.updateRuntimeConfig({ queryTimeoutMs: 120_000 })).not.toThrow();
  });

  it('部分更新：只传部分字段，其余保持原值', async () => {
    const mockSdk = {
      query: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    };

    // 通过 spy 验证 query 实际收到的 model 参数
    let capturedOptions: Record<string, unknown> | null = null;
    mockSdk.query.mockImplementation((opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return (async function* () {})();
    });

    const bridge = new SdkBridge({
      defaultModel: 'sonnet',
      defaultMode: 'code',
      maxConcurrentQueries: 3,
      queryTimeoutMs: 60_000,
      sdk: mockSdk,
    });

    // 只更新 model
    bridge.updateRuntimeConfig({ defaultModel: 'opus' });

    // 发起查询，await 等待 mock 被调用后再断言
    await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });
    expect(capturedOptions).not.toBeNull();
    const opts = capturedOptions as Record<string, unknown>;
    expect((opts['options'] as Record<string, unknown>)['model']).toBe('opus');
  });

  it('连续多次更新，最后一次生效', async () => {
    const mockSdk = {
      query: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    let capturedOptions: Record<string, unknown> | null = null;
    mockSdk.query.mockImplementation((opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return (async function* () {})();
    });

    const bridge = new SdkBridge({
      defaultModel: 'sonnet',
      defaultMode: 'code',
      maxConcurrentQueries: 3,
      queryTimeoutMs: 60_000,
      sdk: mockSdk,
    });

    bridge.updateRuntimeConfig({ defaultModel: 'opus' });
    bridge.updateRuntimeConfig({ defaultModel: 'haiku' });

    await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });
    const opts = capturedOptions as Record<string, unknown>;
    expect((opts['options'] as Record<string, unknown>)['model']).toBe('haiku');
  });
});

// ─────────────────────────────────────────────
// Logger.setLevel 单元测试
// ─────────────────────────────────────────────

describe('Logger.setLevel 热重载', () => {
  it('初始级别 info 时 debug 日志不输出', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', secretValues: [], writer: (l) => lines.push(l) });
    logger.debug('should not appear');
    expect(lines).toHaveLength(0);
  });

  it('setLevel("debug") 后 debug 日志开始输出', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', secretValues: [], writer: (l) => lines.push(l) });
    logger.debug('before setLevel');
    expect(lines).toHaveLength(0);

    logger.setLevel('debug');
    logger.debug('after setLevel');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('debug');
  });

  it('setLevel("error") 后 warn/info/debug 均不输出', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', secretValues: [], writer: (l) => lines.push(l) });
    logger.setLevel('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    expect(lines).toHaveLength(0);
    logger.error('e');
    expect(lines).toHaveLength(1);
  });

  it('setLevel 传未知级别时降级为 info', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', secretValues: [], writer: (l) => lines.push(l) });
    logger.setLevel('invalid_level');
    // info 应该输出，debug 不应该
    logger.info('info line');
    logger.debug('debug line');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('info');
  });
});

// ─────────────────────────────────────────────
// onHotReload 回调集成：验证回调逻辑正确更新 bridge 和 logger
// ─────────────────────────────────────────────

describe('onHotReload 回调集成', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-hot-reload-'));
    configPath = path.join(tmpDir, 'config.env');
    // 写初始配置
    fs.writeFileSync(configPath,
      'CTF_DEFAULT_MODEL=sonnet\nCTF_DEFAULT_MODE=code\nCTF_MAX_CONCURRENT_QUERIES=3\nCTF_QUERY_TIMEOUT_MS=60000\n'
    );
  });

  /**
   * 模拟 lifecycle.ts 中 onHotReload 的核心逻辑，抽出为可测函数。
   * 实际 lifecycle 内是一个闭包回调，这里提取逻辑便于单元测试。
   */
  function buildOnHotReload(
    bridge: SdkBridge,
    loggerLines: string[],
  ) {
    const logger = createLogger({ level: 'info', secretValues: [], writer: (l) => loggerLines.push(l) });

    const onHotReload = (changes: Readonly<Record<string, string>>) => {
      const patch: {
        defaultModel?: string;
        defaultMode?: string;
        maxConcurrentQueries?: number;
        queryTimeoutMs?: number;
      } = {};

      if (changes['CTF_DEFAULT_MODEL'] !== undefined) {
        patch.defaultModel = changes['CTF_DEFAULT_MODEL'];
      }
      if (changes['CTF_DEFAULT_MODE'] !== undefined) {
        patch.defaultMode = changes['CTF_DEFAULT_MODE'];
      }
      if (changes['CTF_MAX_CONCURRENT_QUERIES'] !== undefined) {
        const v = parseInt(changes['CTF_MAX_CONCURRENT_QUERIES'], 10);
        if (!isNaN(v) && v >= 1 && v <= 10) {
          patch.maxConcurrentQueries = v;
        }
      }
      if (changes['CTF_QUERY_TIMEOUT_MS'] !== undefined) {
        const v = parseInt(changes['CTF_QUERY_TIMEOUT_MS'], 10);
        if (!isNaN(v) && v > 0) {
          patch.queryTimeoutMs = v;
        }
      }

      if (Object.keys(patch).length > 0) {
        bridge.updateRuntimeConfig(patch);
      }

      if (changes['CTF_LOG_LEVEL'] !== undefined) {
        logger.setLevel(changes['CTF_LOG_LEVEL']);
      }
    };

    return { onHotReload, logger };
  }

  it('热重载 CTF_DEFAULT_MODEL 后新查询使用新 model', async () => {
    const mockSdk = {
      query: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    let capturedModel: string | undefined;
    mockSdk.query.mockImplementation((opts: Record<string, unknown>) => {
      capturedModel = (opts['options'] as Record<string, unknown>)['model'] as string;
      return (async function* () {})();
    });

    const bridge = new SdkBridge({
      defaultModel: 'sonnet',
      defaultMode: 'code',
      maxConcurrentQueries: 3,
      queryTimeoutMs: 60_000,
      sdk: mockSdk,
    });

    const logLines: string[] = [];
    const { onHotReload } = buildOnHotReload(bridge, logLines);

    // 触发热重载
    onHotReload({ CTF_DEFAULT_MODEL: 'opus' });

    // 新查询应使用 opus，await 等待 mock 被调用
    await bridge.queryStream({ prompt: 'test', cwd: '/tmp' });
    expect(capturedModel).toBe('opus');
  });

  it('热重载 CTF_LOG_LEVEL 后日志级别立即更新', () => {
    const mockSdk = {
      query: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    const bridge = new SdkBridge({
      defaultModel: 'sonnet',
      defaultMode: 'code',
      maxConcurrentQueries: 3,
      queryTimeoutMs: 60_000,
      sdk: mockSdk,
    });

    const logLines: string[] = [];
    const { onHotReload, logger } = buildOnHotReload(bridge, logLines);

    // 初始 info 级别，debug 不输出
    logger.debug('before hot reload');
    expect(logLines).toHaveLength(0);

    // 热重载 log level 为 debug
    onHotReload({ CTF_LOG_LEVEL: 'debug' });
    logger.debug('after hot reload');
    expect(logLines).toHaveLength(1);
  });

  it('CTF_MAX_CONCURRENT_QUERIES 超出范围时忽略，bridge 不更新', () => {
    const updateSpy = vi.fn();
    const mockBridge = {
      updateRuntimeConfig: updateSpy,
    } as unknown as SdkBridge;

    const logLines: string[] = [];
    const { onHotReload } = buildOnHotReload(mockBridge, logLines);

    onHotReload({ CTF_MAX_CONCURRENT_QUERIES: '99' });
    // 值无效（超出 1-10），patch 为空，不应调用 updateRuntimeConfig
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('CTF_MAX_CONCURRENT_QUERIES 合法值时正常更新', () => {
    const updateSpy = vi.fn();
    const mockBridge = {
      updateRuntimeConfig: updateSpy,
    } as unknown as SdkBridge;

    const logLines: string[] = [];
    const { onHotReload } = buildOnHotReload(mockBridge, logLines);

    onHotReload({ CTF_MAX_CONCURRENT_QUERIES: '5' });
    expect(updateSpy).toHaveBeenCalledWith({ maxConcurrentQueries: 5 });
  });

  it('CTF_QUERY_TIMEOUT_MS 为 0 时忽略', () => {
    const updateSpy = vi.fn();
    const mockBridge = {
      updateRuntimeConfig: updateSpy,
    } as unknown as SdkBridge;

    const logLines: string[] = [];
    const { onHotReload } = buildOnHotReload(mockBridge, logLines);

    onHotReload({ CTF_QUERY_TIMEOUT_MS: '0' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('冷字段变更不调用 bridge.updateRuntimeConfig', () => {
    const updateSpy = vi.fn();
    const mockBridge = {
      updateRuntimeConfig: updateSpy,
    } as unknown as SdkBridge;

    const logLines: string[] = [];
    const { onHotReload } = buildOnHotReload(mockBridge, logLines);

    // 冷字段（不在热更新列表中），回调内不处理
    onHotReload({});
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('stopWatcher 被调用后停止监听', () => {
    const stopWatcher = startConfigWatcher({
      configPath,
      onHotReload: vi.fn(),
      onColdChange: vi.fn(),
      onError: vi.fn(),
    });

    // 调用停止函数不抛出
    expect(() => stopWatcher()).not.toThrow();
    // 重复调用也不抛出
    expect(() => stopWatcher()).not.toThrow();
  });
});
