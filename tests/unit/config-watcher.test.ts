import { describe, it, expect } from 'vitest';
import {
  isHotReloadable,
  HOT_RELOADABLE_FIELDS,
  classifyChanges,
  detectChanges,
  parseEnvFile,
} from '../../src/utils/config-watcher.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('热更新字段分类', () => {
  it('logLevel is hot-reloadable', () => {
    expect(isHotReloadable('CTF_LOG_LEVEL')).toBe(true);
  });

  it('maxConcurrentQueries is hot-reloadable', () => {
    expect(isHotReloadable('CTF_MAX_CONCURRENT_QUERIES')).toBe(true);
  });

  it('queryTimeoutMs is hot-reloadable', () => {
    expect(isHotReloadable('CTF_QUERY_TIMEOUT_MS')).toBe(true);
  });

  it('defaultModel is hot-reloadable', () => {
    expect(isHotReloadable('CTF_DEFAULT_MODEL')).toBe(true);
  });

  it('feishu app id is NOT hot-reloadable', () => {
    expect(isHotReloadable('CTF_FEISHU_APP_ID')).toBe(false);
  });

  it('allowed users is NOT hot-reloadable', () => {
    expect(isHotReloadable('CTF_ALLOWED_USERS')).toBe(false);
  });

  it('healthPort is NOT hot-reloadable', () => {
    expect(isHotReloadable('CTF_HEALTH_PORT')).toBe(false);
  });

  it('classifies changes into hot and cold groups', () => {
    const changes = {
      CTF_LOG_LEVEL: 'debug',
      CTF_FEISHU_APP_ID: 'cli_new',
      CTF_MAX_CONCURRENT_QUERIES: '5',
    };
    const { hot, cold } = classifyChanges(changes);
    expect(hot).toEqual({ CTF_LOG_LEVEL: 'debug', CTF_MAX_CONCURRENT_QUERIES: '5' });
    expect(cold).toEqual({ CTF_FEISHU_APP_ID: 'cli_new' });
  });

  it('exports HOT_RELOADABLE_FIELDS list', () => {
    expect(HOT_RELOADABLE_FIELDS).toContain('CTF_LOG_LEVEL');
    expect(HOT_RELOADABLE_FIELDS).toContain('CTF_MAX_CONCURRENT_QUERIES');
    expect(HOT_RELOADABLE_FIELDS.length).toBeGreaterThan(0);
  });
});

describe('配置变更检测', () => {
  it('detects changed values', () => {
    const oldConfig = { CTF_LOG_LEVEL: 'info', CTF_MAX_CONCURRENT_QUERIES: '3' };
    const newConfig = { CTF_LOG_LEVEL: 'debug', CTF_MAX_CONCURRENT_QUERIES: '3' };
    const changes = detectChanges(oldConfig, newConfig);
    expect(changes).toEqual({ CTF_LOG_LEVEL: 'debug' });
  });

  it('detects new keys', () => {
    const oldConfig: Record<string, string> = {};
    const newConfig = { CTF_LOG_LEVEL: 'debug' };
    const changes = detectChanges(oldConfig, newConfig);
    expect(changes).toEqual({ CTF_LOG_LEVEL: 'debug' });
  });

  it('returns empty for no changes', () => {
    const config = { CTF_LOG_LEVEL: 'info' };
    const changes = detectChanges(config, config);
    expect(changes).toEqual({});
  });

  it('detects multiple changes', () => {
    const oldConfig = { A: '1', B: '2', C: '3' };
    const newConfig = { A: '1', B: '99', C: '88' };
    const changes = detectChanges(oldConfig, newConfig);
    expect(changes).toEqual({ B: '99', C: '88' });
  });
});

describe('parseEnvFile', () => {
  it('parses key=value pairs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-test-'));
    const filePath = path.join(tmpDir, 'test.env');
    fs.writeFileSync(filePath, 'KEY1=value1\nKEY2=value2\n');

    const result = parseEnvFile(filePath);
    expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores comments and empty lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-test-'));
    const filePath = path.join(tmpDir, 'test.env');
    fs.writeFileSync(filePath, '# comment\n\nKEY=value\n');

    const result = parseEnvFile(filePath);
    expect(result).toEqual({ KEY: 'value' });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips quotes from values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-test-'));
    const filePath = path.join(tmpDir, 'test.env');
    fs.writeFileSync(filePath, 'KEY1="quoted"\nKEY2=\'single\'\n');

    const result = parseEnvFile(filePath);
    expect(result).toEqual({ KEY1: 'quoted', KEY2: 'single' });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
