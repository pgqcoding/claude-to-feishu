import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 顶层 mock platform，使 getConfigDir 可被测试覆盖
// factory 函数在 vi.mock 提升后立即执行，configDirOverride 需用 getter 延迟读取
let configDirOverride = '';
vi.mock('../../src/utils/platform.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/platform.js')>();
  return {
    ...original,
    // 使用 getter 延迟读取 configDirOverride，确保测试内赋值生效
    getConfigDir: () => configDirOverride || original.getConfigDir(),
  };
});

import { validateConfig, maskSecret, loadConfig } from '../../src/config.js';

describe('config', () => {
  describe('validateConfig', () => {
    it('throws on missing required fields', () => {
      expect(() => validateConfig({})).toThrow('CTF_FEISHU_APP_ID');
    });

    it('throws on invalid APP_ID prefix', () => {
      expect(() => validateConfig({
        CTF_FEISHU_APP_ID: 'invalid',
        CTF_FEISHU_APP_SECRET: 'secret',
        CTF_ALLOWED_USERS: 'ou_abc',
        CTF_ALLOWED_DIRS: 'D:\\work\\project',
      })).toThrow('cli_');
    });

    it('throws on empty ALLOWED_USERS (deny-by-default)', () => {
      expect(() => validateConfig({
        CTF_FEISHU_APP_ID: 'cli_abc',
        CTF_FEISHU_APP_SECRET: 'secret',
        CTF_ALLOWED_USERS: '',
        CTF_ALLOWED_DIRS: 'D:\\work\\project',
      })).toThrow('CTF_ALLOWED_USERS');
    });

    it('accepts valid config and returns frozen object', () => {
      const config = validateConfig({
        CTF_FEISHU_APP_ID: 'cli_abc',
        CTF_FEISHU_APP_SECRET: 'secret',
        CTF_ALLOWED_USERS: 'ou_user1',
        CTF_ALLOWED_DIRS: 'D:\\work\\project-a;D:\\work\\project-b',
        CTF_DIR_ALIASES: 'a=D:\\work\\project-a',
      });
      expect(config.feishuAppId).toBe('cli_abc');
      expect(config.allowedUsers).toEqual(['ou_user1']);
      expect(config.allowedDirs).toHaveLength(2);
      expect(config.dirAliases.get('a')).toBeDefined();
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('uses defaults for optional fields', () => {
      const config = validateConfig({
        CTF_FEISHU_APP_ID: 'cli_abc',
        CTF_FEISHU_APP_SECRET: 'secret',
        CTF_ALLOWED_USERS: 'ou_user1',
        CTF_ALLOWED_DIRS: 'D:\\work\\project',
      });
      expect(config.defaultModel).toBe('sonnet');
      expect(config.maxConcurrentQueries).toBe(3);
      expect(config.queryTimeoutMs).toBe(600000);
    });

    it('throws on out-of-range maxConcurrentQueries', () => {
      expect(() => validateConfig({
        CTF_FEISHU_APP_ID: 'cli_abc',
        CTF_FEISHU_APP_SECRET: 'secret',
        CTF_ALLOWED_USERS: 'ou_user1',
        CTF_ALLOWED_DIRS: 'D:\\work\\project',
        CTF_MAX_CONCURRENT_QUERIES: '0',
      })).toThrow('1-10');
    });
  });

  describe('maskSecret', () => {
    it('masks strings longer than 8 chars', () => {
      expect(maskSecret('my-super-secret-key')).toBe('my-s***');
    });

    it('fully masks short strings', () => {
      expect(maskSecret('short')).toBe('***');
    });
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    // 每个测试用独立临时目录，隔离文件系统副作用
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-config-'));
    configDirOverride = tmpDir;
  });

  afterEach(() => {
    // 清理临时目录，重置 override
    fs.rmSync(tmpDir, { recursive: true, force: true });
    configDirOverride = '';
  });

  it('config.env 文件不存在时抛出明确错误', () => {
    // 临时目录不写任何文件，config.env 不存在
    expect(() => loadConfig()).toThrow('配置文件不存在');
  });

  it('config.env 存在但内容损坏（非 key=value 格式）时返回空解析结果，触发变量缺失错误', () => {
    // dotenv 对格式错误不会报 error，只会返回空 parsed，最终触发 validateConfig 错误
    const configPath = path.join(tmpDir, 'config.env');
    fs.writeFileSync(configPath, 'THIS IS NOT VALID ENV FORMAT AT ALL!!!', 'utf8');
    // 应抛出必要变量缺失错误
    expect(() => loadConfig()).toThrow('CTF_FEISHU_APP_ID');
  });

  it('config.env 存在且必要变量齐全时正常返回 Config 对象', () => {
    const configPath = path.join(tmpDir, 'config.env');
    // 写入合法的 config.env 内容
    const envContent = [
      'CTF_FEISHU_APP_ID=cli_test_app_123',
      'CTF_FEISHU_APP_SECRET=test_secret_value',
      'CTF_ALLOWED_USERS=ou_user1;ou_user2',
      `CTF_ALLOWED_DIRS=${tmpDir}`,
      'CTF_DEFAULT_MODEL=sonnet',
      'CTF_LOG_LEVEL=debug',
    ].join('\n');
    fs.writeFileSync(configPath, envContent, 'utf8');

    const config = loadConfig();

    expect(config.feishuAppId).toBe('cli_test_app_123');
    expect(config.feishuAppSecret).toBe('test_secret_value');
    expect(config.allowedUsers).toEqual(['ou_user1', 'ou_user2']);
    expect(config.defaultModel).toBe('sonnet');
    expect(config.logLevel).toBe('debug');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('config.env 存在但缺少必要变量时抛出验证错误', () => {
    const configPath = path.join(tmpDir, 'config.env');
    // 只写一个无关的变量，缺少所有必要字段
    fs.writeFileSync(configPath, 'CTF_LOG_LEVEL=info\n', 'utf8');
    // 应抛出 CTF_FEISHU_APP_ID 未设置
    expect(() => loadConfig()).toThrow('CTF_FEISHU_APP_ID');
  });
});
