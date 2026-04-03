import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const requestIdStorage = new AsyncLocalStorage<string>();

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

export interface LoggerOptions {
  readonly level: string;
  readonly secretValues: readonly string[];
  readonly writer?: (line: string) => void;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  /** 热重载：动态更新日志级别，立即对新日志生效 */
  setLevel(level: string): void;
}

/** 文件写入器接口，供 lifecycle shutdown 调用 destroy() 刷盘 */
export interface FileWriter {
  /** 同步入队一行日志（WriteStream 内部异步写入，顺序保证） */
  write(line: string): void;
  /** 关闭底层 WriteStream，等待缓冲区全部落盘 */
  destroy(): Promise<void>;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * 单值脱敏：保留前 4 字符并附加 ***，用于配置项展示。
 * 值长度 <= 8 时直接返回 ***，避免泄露过多信息。
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***';
}

/**
 * 批量脱敏：将日志文本中出现的所有 secret 值替换为 ***。
 * 用于日志输出前的全量扫描，防止密钥明文写入日志。
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text;
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join('***');
    }
  }
  return result;
}

export function createLogger(options: LoggerOptions): Logger {
  // 使用可变变量，支持热重载时动态更新级别
  let minLevel = LOG_LEVELS[options.level as LogLevel] ?? LOG_LEVELS.info;
  const secrets = options.secretValues;
  const write = options.writer ?? ((line: string) => {
    process.stderr.write(line + '\n');
  });

  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < minLevel) return;

    const maskedMsg = maskSecrets(msg, secrets);
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: maskedMsg,
      ...extra,
    };

    const requestId = getRequestId();
    if (requestId) {
      entry.requestId = requestId;
    }

    const line = maskSecrets(JSON.stringify(entry), secrets);
    write(line);
  }

  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    setLevel: (level: string) => {
      minLevel = LOG_LEVELS[level as LogLevel] ?? LOG_LEVELS.info;
    },
  };
}

interface FileWriterOptions {
  readonly maxBytes: number;
  readonly maxHistory: number;
}

/** 轮转判断所需的上下文信息 */
export interface RotationCheck {
  readonly fileSizeBytes: number;
  readonly lastRotationTime: number;
  readonly currentTime: number;
  readonly maxSizeBytes: number;
}

/**
 * 判断是否跨天（比较日期字符串，忽略时间部分）
 */
export function shouldRotateByDate(lastRotationTime: number, currentTime: number): boolean {
  const last = new Date(lastRotationTime).toDateString();
  const current = new Date(currentTime).toDateString();
  return last !== current;
}

/**
 * 生成日期后缀文件名
 * app.log → app.2026-03-19.log
 * app     → app.2026-03-19
 */
export function getRotatedFileName(baseName: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex === -1) {
    return `${baseName}.${dateStr}`;
  }
  const name = baseName.slice(0, dotIndex);
  const ext = baseName.slice(dotIndex);
  return `${name}.${dateStr}${ext}`;
}

/**
 * 双条件判断：文件大小超限 OR 日期已跨天，任一满足即触发轮转
 */
export function shouldRotate(check: RotationCheck): boolean {
  if (check.fileSizeBytes >= check.maxSizeBytes) return true;
  return shouldRotateByDate(check.lastRotationTime, check.currentTime);
}

/**
 * 创建一个 WriteStream 并返回 end 的 Promise
 */
function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

/**
 * 打开 append 模式的 WriteStream
 */
function openStream(filePath: string): fs.WriteStream {
  return fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
}

/**
 * 异步文件写入器（替代 appendFileSync）。
 *
 * - 使用 WriteStream（append 模式），写入有序且非阻塞
 * - 日志轮转时先 end 旧 stream，异步完成 rename/unlink，再打开新 stream
 * - 轮转期间的日志行排队等待，轮转完成后自动写入
 * - destroy() 供 shutdown 时调用，等待缓冲区全部落盘
 */
export function createFileWriter(
  filePath: string,
  options: FileWriterOptions = { maxBytes: 50 * 1024 * 1024, maxHistory: 3 }
): FileWriter {
  const { maxBytes, maxHistory } = options;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // 记录上次轮转时间，初始为文件的 mtime，文件不存在则为当前时间
  let lastRotationTime: number = (() => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return Date.now();
    }
  })();

  // 用字节计数器追踪当前文件大小，避免每次写入都 stat
  let currentBytes: number = (() => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  })();

  // 当前活跃的 WriteStream
  let stream: fs.WriteStream = openStream(filePath);

  // 轮转期间的待写队列（drain 后批量写入）
  let rotating = false;
  const pending: string[] = [];

  /**
   * 按日期轮转：将当前日志文件重命名为带日期后缀的文件名
   */
  async function rotateByDate(rotateTime: Date): Promise<void> {
    const baseName = path.basename(filePath);
    const dateSuffix = getRotatedFileName(baseName, rotateTime);
    const rotatedPath = path.join(dir, dateSuffix);

    // 同一天内可能已有同名归档，追加序号避免覆盖
    let target = rotatedPath;
    for (let i = 1; i <= maxHistory; i++) {
      if (!fs.existsSync(target)) break;
      target = `${rotatedPath}.${i}`;
      if (i === maxHistory) {
        try { await fsPromises.unlink(target); } catch { /* ignore */ }
      }
    }

    try {
      await fsPromises.rename(filePath, target);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[logger] rotate failed: ${err}\n`);
      }
    }
  }

  /**
   * 按大小轮转：序号命名 .1 .2 .3
   */
  async function rotateBySize(): Promise<void> {
    for (let i = maxHistory; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      if (i === maxHistory) {
        try { await fsPromises.unlink(to); } catch { /* ignore */ }
      }
      try {
        await fsPromises.rename(from, to);
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write(`[logger] rotate failed: ${err}\n`);
        }
      }
    }
  }

  /**
   * 执行轮转：关闭旧 stream → 异步 rename/unlink → 打开新 stream → 写出积压队列
   */
  async function performRotation(now: number): Promise<void> {
    // 关闭旧 stream，等待缓冲区落盘
    const oldStream = stream;
    await closeStream(oldStream);

    if (shouldRotateByDate(lastRotationTime, now)) {
      await rotateByDate(new Date(lastRotationTime));
    } else {
      await rotateBySize();
    }

    lastRotationTime = now;
    currentBytes = 0;

    // 打开新 stream
    stream = openStream(filePath);

    // 写出轮转期间积压的日志行
    rotating = false;
    const queued = pending.splice(0);
    for (const line of queued) {
      writeToStream(line);
    }
  }

  /**
   * 直接写入当前 stream，并更新字节计数
   */
  function writeToStream(line: string): void {
    const data = line + '\n';
    stream.write(data, (err) => {
      if (err) {
        process.stderr.write(line + '\n');
      }
    });
    currentBytes += Buffer.byteLength(data);
  }

  return {
    write(line: string): void {
      try {
        // 轮转进行中，先排队
        if (rotating) {
          pending.push(line);
          return;
        }

        const now = Date.now();
        const needsRotate = shouldRotate({
          fileSizeBytes: currentBytes,
          lastRotationTime,
          currentTime: now,
          maxSizeBytes: maxBytes,
        });

        if (needsRotate) {
          rotating = true;
          pending.push(line);
          // 轮转为异步，期间后续 write 会进入 pending 队列
          performRotation(now).catch((err) => {
            process.stderr.write(`[logger] rotation error: ${err}\n`);
            rotating = false;
          });
          return;
        }

        writeToStream(line);
      } catch {
        process.stderr.write(line + '\n');
      }
    },

    async destroy(): Promise<void> {
      // 等待轮转完成（最多 5 秒）
      if (rotating) {
        const deadline = Date.now() + 5000;
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (!rotating || Date.now() >= deadline) {
              resolve();
            } else {
              setTimeout(check, 10);
            }
          };
          check();
        });
      }
      await closeStream(stream);
    },
  };
}
