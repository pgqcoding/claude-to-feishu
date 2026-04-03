import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/core/store.js';
import type { AppState } from '../../src/types.js';

const EMPTY_STATE: AppState = {
  version: 1,
  currentBinding: null,
  recentSessionIds: [],
};

describe('store', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-store-'));
    storePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty state when file does not exist', async () => {
    const store = new Store(storePath);
    const state = await store.load();
    expect(state).toEqual(EMPTY_STATE);
  });

  it('saves and loads state', async () => {
    const store = new Store(storePath);
    const state: AppState = {
      version: 1,
      currentBinding: {
        sessionId: 'abc',
        projectDir: '/work/project',
        projectAlias: 'project',
        boundAt: Date.now(),
      },
      recentSessionIds: ['abc', 'def'],
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).toEqual(state);
  });

  it('uses write-then-rename (tmp file should not persist)', async () => {
    const store = new Store(storePath);
    await store.save(EMPTY_STATE);
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('handles concurrent saves without corruption', async () => {
    const store = new Store(storePath);
    const saves = Array.from({ length: 3 }, (_, i) =>
      store.save({
        version: 1,
        currentBinding: null,
        recentSessionIds: [`session-${i}`],
      })
    );
    const results = await Promise.all(saves);
    expect(results.every(r => r === true)).toBe(true);
    const loaded = await store.load();
    expect(loaded.version).toBe(1);
    expect(loaded.recentSessionIds).toHaveLength(1);
  });

  it('load() 内存缓存命中时不读取文件系统', async () => {
    const store = new Store(storePath);
    const state: AppState = {
      version: 1,
      currentBinding: null,
      recentSessionIds: ['cached-session'],
    };
    // 先 save 触发冷启动写入并填充内存缓存
    await store.save(state);

    // spy fs.readFileSync，后续 load 不应调用它
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const loaded = await store.load();
    expect(loaded).toEqual(state);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('save() 失败时 inMemoryState 不更新为未持久化状态', async () => {
    const store = new Store(storePath);
    // 先建立初始状态
    const initial: AppState = { version: 1, currentBinding: null, recentSessionIds: ['init'] };
    await store.save(initial);

    // 模拟写入失败
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('磁盘写入失败');
    });

    const newState: AppState = { version: 1, currentBinding: null, recentSessionIds: ['new'] };
    const result = await store.save(newState);
    expect(result).toBe(false);

    // inMemoryState 应仍是上次成功持久化的 initial，而非 newState
    expect(store.getInMemoryState()).toEqual(initial);
    writeSpy.mockRestore();
  });

  it('recovers from corrupted JSON', async () => {
    fs.writeFileSync(storePath, '{invalid json');
    const store = new Store(storePath);
    const state = await store.load();
    expect(state).toEqual(EMPTY_STATE);
    // 损坏文件应被备份
    const backups = fs.readdirSync(tmpDir).filter(f => f.includes('.corrupted.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  describe('降级保护', () => {
    it('文件 version 高于当前代码版本时，返回默认状态且不 crash', async () => {
      // 模拟高版本写入的状态文件
      const futureState = {
        version: 9999,
        currentBinding: { sessionId: 'future', projectDir: '/x', projectAlias: 'x', boundAt: 0 },
        recentSessionIds: ['future-session'],
        unknownNewField: 'someValue',
      };
      fs.writeFileSync(storePath, JSON.stringify(futureState));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new Store(storePath);
      const state = await store.load();

      // 应返回默认空状态，不保留高版本数据
      expect(state).toEqual(EMPTY_STATE);

      // 应记录 warn 日志，提示降级情况
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('高于当前应用版本');
      warnSpy.mockRestore();
    });

    it('文件 version 等于当前代码版本时，正常加载', async () => {
      const normalState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['normal-session'],
      };
      fs.writeFileSync(storePath, JSON.stringify(normalState));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new Store(storePath);
      const state = await store.load();

      expect(state).toEqual(normalState);
      // 不应触发降级警告
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('.tmp 文件恢复逻辑', () => {
    it('.tmp 比主文件新时，rename .tmp 为主文件并加载其内容', async () => {
      const tmpFilePath = storePath + '.tmp';
      const newerState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['recovered-session'],
      };
      const olderState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['old-session'],
      };

      // 先写入主文件（旧内容）
      fs.writeFileSync(storePath, JSON.stringify(olderState));
      // 稍等一点确保 mtime 有差异，再写 .tmp（新内容）
      await new Promise(r => setTimeout(r, 10));
      fs.writeFileSync(tmpFilePath, JSON.stringify(newerState));

      // 确认 .tmp 比主文件更新
      const tmpMtime = fs.statSync(tmpFilePath).mtimeMs;
      const mainMtime = fs.statSync(storePath).mtimeMs;
      expect(tmpMtime).toBeGreaterThan(mainMtime);

      // 冷启动（全新 Store 实例，inMemoryState 为 null）
      const store = new Store(storePath);
      const loaded = await store.load();

      // 应加载 .tmp 文件内容（更新的状态）
      expect(loaded).toEqual(newerState);
      // .tmp 文件应被 rename，不再存在
      expect(fs.existsSync(tmpFilePath)).toBe(false);
      // 主文件应存在
      expect(fs.existsSync(storePath)).toBe(true);
    });

    it('.tmp 比主文件旧时，删除 .tmp 并加载主文件', async () => {
      const tmpFilePath = storePath + '.tmp';
      const mainState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['main-session'],
      };
      const staleState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['stale-session'],
      };

      // 先写 .tmp（旧内容）
      fs.writeFileSync(tmpFilePath, JSON.stringify(staleState));
      // 再写主文件（更新内容）
      await new Promise(r => setTimeout(r, 10));
      fs.writeFileSync(storePath, JSON.stringify(mainState));

      // 确认主文件比 .tmp 更新
      const tmpMtime = fs.statSync(tmpFilePath).mtimeMs;
      const mainMtime = fs.statSync(storePath).mtimeMs;
      expect(mainMtime).toBeGreaterThan(tmpMtime);

      // 冷启动
      const store = new Store(storePath);
      const loaded = await store.load();

      // 应加载主文件内容
      expect(loaded).toEqual(mainState);
      // .tmp 文件应被删除
      expect(fs.existsSync(tmpFilePath)).toBe(false);
    });

    it('只有 .tmp 文件（无主文件）时，rename .tmp 为主文件并加载', async () => {
      const tmpFilePath = storePath + '.tmp';
      const tmpState: AppState = {
        version: 1,
        currentBinding: null,
        recentSessionIds: ['only-tmp-session'],
      };

      // 只写 .tmp，不写主文件
      fs.writeFileSync(tmpFilePath, JSON.stringify(tmpState));
      expect(fs.existsSync(storePath)).toBe(false);

      // 冷启动
      const store = new Store(storePath);
      const loaded = await store.load();

      // 应从 .tmp 恢复
      expect(loaded).toEqual(tmpState);
      // .tmp 应消失，主文件出现
      expect(fs.existsSync(tmpFilePath)).toBe(false);
      expect(fs.existsSync(storePath)).toBe(true);
    });
  });
});
