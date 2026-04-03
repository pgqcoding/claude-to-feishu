import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 在 import 源模块之前设置 mock，保证 mock 生效
vi.mock('../../src/utils/platform.js', () => ({
  isProcessAlive: vi.fn(),
}));

import { writePidFile, removePidFile, checkExistingProcess, readShutdownToken } from '../../src/daemon/pid.js';
import { isProcessAlive } from '../../src/utils/platform.js';

const mockIsProcessAlive = vi.mocked(isProcessAlive);

/** 根据 PID 文件路径推导 token 文件路径（与实现保持一致） */
function tokenPath(pidPath: string): string {
  return pidPath.replace(/\.pid$/, '.shutdown.token');
}

describe('pid', () => {
  let tmpDir: string;
  let pidPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-pid-'));
    pidPath = path.join(tmpDir, 'daemon.pid');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- writePidFile ---

  it('writePidFile 写入包含 pid、startTime、httpPort 的 JSON', () => {
    writePidFile(pidPath, 8080);

    const content = fs.readFileSync(pidPath, 'utf8');
    const info = JSON.parse(content);

    expect(info.pid).toBe(process.pid);
    expect(info.httpPort).toBe(8080);
    expect(typeof info.startTime).toBe('number');
    expect(info.startTime).toBeGreaterThan(0);
  });

  it('writePidFile 写入的文件可被 JSON.parse 正确解析', () => {
    writePidFile(pidPath, 9090);

    const content = fs.readFileSync(pidPath, 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('writePidFile 同时写入 token 文件，返回非空 token 字符串', () => {
    const token = writePidFile(pidPath, 8080);

    // 返回值为非空字符串
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // token 文件存在且内容与返回值一致
    const tPath = tokenPath(pidPath);
    expect(fs.existsSync(tPath)).toBe(true);
    expect(fs.readFileSync(tPath, 'utf8')).toBe(token);
  });

  it('writePidFile 每次生成不同的 token', () => {
    const token1 = writePidFile(pidPath, 8080);
    const token2 = writePidFile(pidPath, 8080);

    expect(token1).not.toBe(token2);
  });

  // --- readShutdownToken ---

  it('readShutdownToken 在 token 文件存在时返回对应 token', () => {
    const token = writePidFile(pidPath, 8080);

    const result = readShutdownToken(pidPath);
    expect(result).toBe(token);
  });

  it('readShutdownToken 在 token 文件不存在时返回 null', () => {
    const result = readShutdownToken(pidPath);
    expect(result).toBeNull();
  });

  // --- removePidFile ---

  it('removePidFile 删除存在的 PID 文件', () => {
    fs.writeFileSync(pidPath, '{}');
    expect(fs.existsSync(pidPath)).toBe(true);

    removePidFile(pidPath);

    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('removePidFile 同时删除 token 文件', () => {
    writePidFile(pidPath, 8080);

    const tPath = tokenPath(pidPath);
    expect(fs.existsSync(tPath)).toBe(true);

    removePidFile(pidPath);

    expect(fs.existsSync(pidPath)).toBe(false);
    expect(fs.existsSync(tPath)).toBe(false);
  });

  it('removePidFile 文件不存在时不抛出异常', () => {
    // pidPath 不存在
    expect(() => removePidFile(pidPath)).not.toThrow();
  });

  // --- checkExistingProcess ---

  it('文件不存在 → 返回 null', () => {
    const result = checkExistingProcess(pidPath);
    expect(result).toBeNull();
  });

  it('文件存在且进程存活 → 返回 PidInfo', () => {
    const info = { pid: 12345, startTime: Date.now(), httpPort: 8080 };
    fs.writeFileSync(pidPath, JSON.stringify(info));
    mockIsProcessAlive.mockReturnValue(true);

    const result = checkExistingProcess(pidPath);

    expect(result).not.toBeNull();
    expect(result?.pid).toBe(12345);
    expect(result?.httpPort).toBe(8080);
  });

  it('文件存在但进程已死 → 清理 PID 文件并返回 null', () => {
    const info = { pid: 99999, startTime: Date.now(), httpPort: 8080 };
    fs.writeFileSync(pidPath, JSON.stringify(info));
    mockIsProcessAlive.mockReturnValue(false);

    const result = checkExistingProcess(pidPath);

    expect(result).toBeNull();
    // PID 文件应被清理
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('PID 文件内容损坏（无效 JSON）→ 返回 null', () => {
    fs.writeFileSync(pidPath, '{invalid json');

    const result = checkExistingProcess(pidPath);

    expect(result).toBeNull();
  });

  it('PID 为非正整数 → 清理文件并返回 null', () => {
    const info = { pid: -1, startTime: Date.now(), httpPort: 8080 };
    fs.writeFileSync(pidPath, JSON.stringify(info));

    const result = checkExistingProcess(pidPath);

    expect(result).toBeNull();
    // 无效 PID 的文件应被清理
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('PID 为小数 → 清理文件并返回 null', () => {
    const info = { pid: 1.5, startTime: Date.now(), httpPort: 8080 };
    fs.writeFileSync(pidPath, JSON.stringify(info));

    const result = checkExistingProcess(pidPath);

    expect(result).toBeNull();
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});
