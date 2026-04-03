import { describe, it, expect } from 'vitest';
import {
  needsMigration,
  getMigrationPath,
  createBackup,
  executeMigration,
  CURRENT_STORE_VERSION,
  STORE_MIGRATIONS,
} from '../../src/core/migration.js';
import type { MigrationFn } from '../../src/core/migration.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('版本检测', () => {
  it('returns false when versions match', () => {
    expect(needsMigration(2, 2)).toBe(false);
  });

  it('returns true when store version is lower', () => {
    expect(needsMigration(1, 2)).toBe(true);
  });

  it('throws when store version is higher than app version', () => {
    expect(() => needsMigration(3, 2)).toThrow('降级');
  });

  it('returns false for version 0 to 0', () => {
    expect(needsMigration(0, 0)).toBe(false);
  });
});

describe('迁移路径', () => {
  it('returns ordered migration steps', () => {
    const steps = getMigrationPath(1, 3);
    expect(steps).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });

  it('returns empty path when no migration needed', () => {
    const steps = getMigrationPath(3, 3);
    expect(steps).toEqual([]);
  });

  it('returns single step for consecutive versions', () => {
    const steps = getMigrationPath(1, 2);
    expect(steps).toEqual([{ from: 1, to: 2 }]);
  });
});

describe('备份', () => {
  it('creates backup directory with timestamp', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-test-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'store.json'), '{"version":1}');

    const backupPath = await createBackup(dataDir);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(backupPath).toContain('backup');

    // 验证备份内容
    const backupContent = fs.readFileSync(path.join(backupPath, 'store.json'), 'utf-8');
    expect(backupContent).toBe('{"version":1}');

    // 清理
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(backupPath, { recursive: true, force: true });
  });

  it('preserves nested directory structure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-test-'));
    const dataDir = path.join(tmpDir, 'data');
    const subDir = path.join(dataDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'nested.json'), '{}');

    const backupPath = await createBackup(dataDir);
    expect(fs.existsSync(path.join(backupPath, 'sub', 'nested.json'))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(backupPath, { recursive: true, force: true });
  });
});

describe('迁移执行', () => {
  it('applies migration function and updates version', async () => {
    const state: Record<string, unknown> = { version: 1, data: 'old' };
    const migrations: Map<number, MigrationFn> = new Map([
      [2, (s) => ({ ...s, version: 2, data: 'migrated' })],
    ]);

    const result = await executeMigration(state, 1, 2, migrations);
    expect(result.version).toBe(2);
    expect(result.data).toBe('migrated');
  });

  it('applies multiple migrations in order', async () => {
    const state: Record<string, unknown> = { version: 1, value: 0 };
    const migrations: Map<number, MigrationFn> = new Map([
      [2, (s) => ({ ...s, version: 2, value: (s.value as number) + 10 })],
      [3, (s) => ({ ...s, version: 3, value: (s.value as number) * 2 })],
    ]);

    const result = await executeMigration(state, 1, 3, migrations);
    expect(result.version).toBe(3);
    expect(result.value).toBe(20); // (0 + 10) * 2
  });

  it('throws when migration function is missing', async () => {
    const state: Record<string, unknown> = { version: 1 };
    const migrations: Map<number, MigrationFn> = new Map();

    await expect(executeMigration(state, 1, 2, migrations)).rejects.toThrow('缺少迁移脚本');
  });

  it('does not mutate original state', async () => {
    const state: Record<string, unknown> = { version: 1, data: 'original' };
    const migrations: Map<number, MigrationFn> = new Map([
      [2, (s) => ({ ...s, version: 2, data: 'changed' })],
    ]);

    await executeMigration(state, 1, 2, migrations);
    expect(state.data).toBe('original');
  });

  it('returns same state when no steps needed', async () => {
    const state: Record<string, unknown> = { version: 3 };
    const migrations: Map<number, MigrationFn> = new Map();

    const result = await executeMigration(state, 3, 3, migrations);
    expect(result.version).toBe(3);
  });
});

describe('常量导出', () => {
  it('CURRENT_STORE_VERSION is 1', () => {
    expect(CURRENT_STORE_VERSION).toBe(1);
  });

  it('STORE_MIGRATIONS is a Map', () => {
    expect(STORE_MIGRATIONS).toBeInstanceOf(Map);
  });
});
