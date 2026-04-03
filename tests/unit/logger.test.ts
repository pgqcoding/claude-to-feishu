import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger, runWithRequestId, createFileWriter } from '../../src/utils/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('logger', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
  });

  it('outputs structured JSON lines', () => {
    const logger = createLogger({
      level: 'info',
      secretValues: [],
      writer: (line: string) => { output.push(line); },
    });
    logger.info('test message', { module: 'test' });
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.module).toBe('test');
    expect(parsed.ts).toBeDefined();
  });

  it('masks secret values in log output', () => {
    const logger = createLogger({
      level: 'info',
      secretValues: ['my-super-secret'],
      writer: (line: string) => { output.push(line); },
    });
    logger.info('token is my-super-secret here');
    const parsed = JSON.parse(output[0]);
    expect(parsed.msg).not.toContain('my-super-secret');
    expect(parsed.msg).toContain('***');
  });

  it('masks secrets in extra fields', () => {
    const logger = createLogger({
      level: 'info',
      secretValues: ['secret123'],
      writer: (line: string) => { output.push(line); },
    });
    logger.info('check', { token: 'secret123' });
    expect(output[0]).not.toContain('secret123');
  });

  it('respects log level', () => {
    const logger = createLogger({
      level: 'warn',
      secretValues: [],
      writer: (line: string) => { output.push(line); },
    });
    logger.info('should not appear');
    logger.warn('should appear');
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]).level).toBe('warn');
  });

  it('includes requestId from AsyncLocalStorage', async () => {
    const logger = createLogger({
      level: 'info',
      secretValues: [],
      writer: (line: string) => { output.push(line); },
    });
    await runWithRequestId('req-123', () => {
      logger.info('inside request');
      return Promise.resolve();
    });
    const parsed = JSON.parse(output[0]);
    expect(parsed.requestId).toBe('req-123');
  });

  it('omits requestId when not in context', () => {
    const logger = createLogger({
      level: 'info',
      secretValues: [],
      writer: (line: string) => { output.push(line); },
    });
    logger.info('no context');
    const parsed = JSON.parse(output[0]);
    expect(parsed.requestId).toBeUndefined();
  });
});

describe('log rotation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-log-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rotates log file when exceeding max size', async () => {
    const logPath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(logPath, 'x'.repeat(100));
    const writer = createFileWriter(logPath, { maxBytes: 100, maxHistory: 3 });
    writer.write('new line');
    // 等待轮转完成（异步）
    await writer.destroy();
    expect(fs.existsSync(path.join(tmpDir, 'app.log.1'))).toBe(true);
  });

  it('异步写入：destroy 后内容落盘', async () => {
    const logPath = path.join(tmpDir, 'async.log');
    const writer = createFileWriter(logPath, { maxBytes: 50 * 1024 * 1024, maxHistory: 3 });
    writer.write('line1');
    writer.write('line2');
    writer.write('line3');
    await writer.destroy();
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('line1');
    expect(lines[1]).toBe('line2');
    expect(lines[2]).toBe('line3');
  });

  it('写入顺序与调用顺序一致', async () => {
    const logPath = path.join(tmpDir, 'order.log');
    const writer = createFileWriter(logPath, { maxBytes: 50 * 1024 * 1024, maxHistory: 3 });
    const count = 50;
    for (let i = 0; i < count; i++) {
      writer.write(`msg-${i}`);
    }
    await writer.destroy();
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(lines[i]).toBe(`msg-${i}`);
    }
  });

  it('按大小轮转后新日志写入新文件', async () => {
    const logPath = path.join(tmpDir, 'size.log');
    // 预置接近上限的内容
    fs.writeFileSync(logPath, 'x'.repeat(90));
    const writer = createFileWriter(logPath, { maxBytes: 100, maxHistory: 3 });
    writer.write('trigger rotation');
    writer.write('after rotation');
    await writer.destroy();
    // 轮转文件存在
    expect(fs.existsSync(path.join(tmpDir, 'size.log.1'))).toBe(true);
    // 新文件含轮转后的日志
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toContain('after rotation');
  });

  it('destroy 可多次调用不抛出', async () => {
    const logPath = path.join(tmpDir, 'destroy.log');
    const writer = createFileWriter(logPath, { maxBytes: 50 * 1024 * 1024, maxHistory: 3 });
    writer.write('hello');
    await writer.destroy();
    // 第二次 destroy 不应抛出（WriteStream end 后再 end 是 no-op）
    await expect(writer.destroy()).resolves.not.toThrow();
  });

  it('按天轮转生成带日期后缀的归档文件', async () => {
    const logPath = path.join(tmpDir, 'daily.log');
    // 写入初始内容，mtime 设为昨天
    fs.writeFileSync(logPath, 'old content\n');
    // 手动设置上次修改时间为昨天，触发日期轮转
    const yesterday = new Date(Date.now() - 86400_000);
    fs.utimesSync(logPath, yesterday, yesterday);

    const writer = createFileWriter(logPath, { maxBytes: 50 * 1024 * 1024, maxHistory: 3 });
    writer.write('new day entry');
    await writer.destroy();

    // 检查归档文件存在（带日期后缀）
    const files = fs.readdirSync(tmpDir);
    const archived = files.filter(f => f.startsWith('daily.') && f !== 'daily.log');
    expect(archived.length).toBeGreaterThanOrEqual(1);
    // 新文件含新日志
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toContain('new day entry');
  });
});
