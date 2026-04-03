import path from 'node:path';
import fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { getConfigDir, normalizePath } from './utils/platform.js';
// 脱敏工具统一由 logger 模块提供
export { maskSecret } from './utils/logger.js';

export interface Config {
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly feishuDomain: string;
  readonly allowedUsers: readonly string[];
  readonly allowedDirs: readonly string[];
  readonly dirAliases: ReadonlyMap<string, string>;
  readonly defaultModel: string;
  readonly defaultMode: string;
  readonly logLevel: string;
  readonly maxConcurrentQueries: number;
  readonly queryTimeoutMs: number;
  readonly healthPort: number;
  readonly secretValues: readonly string[];
  readonly permissionAllowList: readonly string[];
  /** 入站限流：每个用户每分钟最多处理的消息数，0 表示不限流 */
  readonly inboundRateLimitPerMinute: number;
}

// 最低兼容 Claude CLI 版本
export const MIN_CLI_VERSION = '1.0.0';

export function validateConfig(env: Record<string, string | undefined>): Config {
  const get = (key: string): string => {
    const val = env[key]?.trim();
    if (!val) throw new Error(`配置错误：${key} 未设置，请参考 config.env.example`);
    return val;
  };

  const feishuAppId = get('CTF_FEISHU_APP_ID');
  if (!feishuAppId.startsWith('cli_')) {
    throw new Error('配置错误：CTF_FEISHU_APP_ID 应以 cli_ 开头');
  }

  const feishuAppSecret = get('CTF_FEISHU_APP_SECRET');

  const allowedUsersRaw = get('CTF_ALLOWED_USERS');
  const allowedUsers = allowedUsersRaw.split(';').map(s => s.trim()).filter(Boolean);
  if (allowedUsers.length === 0) {
    throw new Error('配置错误：CTF_ALLOWED_USERS 不能为空（deny-by-default）');
  }
  for (const u of allowedUsers) {
    if (!u.startsWith('ou_')) {
      throw new Error(`配置错误：CTF_ALLOWED_USERS 中 "${u}" 应以 ou_ 开头`);
    }
  }

  const allowedDirsRaw = get('CTF_ALLOWED_DIRS');
  const allowedDirs = allowedDirsRaw.split(';').map(s => normalizePath(s.trim())).filter(Boolean);
  if (allowedDirs.length === 0) {
    throw new Error('配置错误：CTF_ALLOWED_DIRS 不能为空');
  }

  const dirAliases = new Map<string, string>();
  const aliasesRaw = env['CTF_DIR_ALIASES']?.trim();
  if (aliasesRaw) {
    for (const pair of aliasesRaw.split(';')) {
      const [alias, dir] = pair.split('=', 2);
      if (alias && dir) {
        dirAliases.set(alias.trim(), normalizePath(dir.trim()));
      }
    }
  }

  const feishuDomain = env['CTF_FEISHU_DOMAIN']?.trim() || 'https://open.feishu.cn';
  const defaultModel = env['CTF_DEFAULT_MODEL']?.trim() || 'sonnet';
  const defaultMode = env['CTF_DEFAULT_MODE']?.trim() || 'code';
  const logLevel = env['CTF_LOG_LEVEL']?.trim() || 'info';

  const maxConcurrentQueries = parseInt(env['CTF_MAX_CONCURRENT_QUERIES'] || '3', 10);
  if (maxConcurrentQueries < 1 || maxConcurrentQueries > 10) {
    throw new Error('配置错误：CTF_MAX_CONCURRENT_QUERIES 应在 1-10 之间');
  }

  const queryTimeoutMs = parseInt(env['CTF_QUERY_TIMEOUT_MS'] || '600000', 10);
  if (queryTimeoutMs <= 0) {
    throw new Error('配置错误：CTF_QUERY_TIMEOUT_MS 应为正整数');
  }

  const healthPort = parseInt(env['CTF_HEALTH_PORT'] || '0', 10);
  if (healthPort < 0 || healthPort > 65535) {
    throw new Error('配置错误：CTF_HEALTH_PORT 应在 0-65535 之间');
  }

  // 收集需要在日志中脱敏的密钥值：飞书 AppSecret + 所有包含 KEY/SECRET/TOKEN 的环境变量
  const sensitiveEnvValues = Object.entries(env)
    .filter(([k, v]) => v && /KEY|SECRET|TOKEN/i.test(k))
    .map(([, v]) => v as string);
  const secretValues = Array.from(new Set([feishuAppSecret, ...sensitiveEnvValues])).filter(s => s.length > 0);

  const permissionAllowListRaw = env['CTF_PERMISSION_ALLOW_LIST']?.trim();
  const permissionAllowList = permissionAllowListRaw
    ? permissionAllowListRaw.split(';').map(s => s.trim()).filter(Boolean)
    : [];

  // 入站限流：每用户每分钟消息数，0 表示不限流，默认 20
  const inboundRateLimitPerMinute = parseInt(env['CTF_INBOUND_RATE_LIMIT'] || '20', 10);
  if (inboundRateLimitPerMinute < 0 || inboundRateLimitPerMinute > 1000) {
    throw new Error('配置错误：CTF_INBOUND_RATE_LIMIT 应在 0-1000 之间（0 表示不限流）');
  }

  const config: Config = {
    feishuAppId,
    feishuAppSecret,
    feishuDomain,
    allowedUsers,
    allowedDirs,
    dirAliases,
    defaultModel,
    defaultMode,
    logLevel,
    maxConcurrentQueries,
    queryTimeoutMs,
    healthPort,
    secretValues,
    permissionAllowList,
    inboundRateLimitPerMinute,
  };

  return Object.freeze(config);
}

export function loadConfig(): Config {
  const configPath = path.join(getConfigDir(), 'config.env');
  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件不存在：${configPath}，请复制 config.env.example 并填写`);
  }

  const result = dotenvConfig({ path: configPath });
  if (result.error) {
    throw new Error(`配置文件解析失败：${result.error.message}`);
  }

  return validateConfig(result.parsed || {});
}
