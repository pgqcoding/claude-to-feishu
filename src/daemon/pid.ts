import fs from 'node:fs';
import crypto from 'node:crypto';
import { isProcessAlive } from '../utils/platform.js';

interface PidInfo {
  readonly pid: number;
  readonly startTime: number;
  readonly httpPort: number;
}

/** 根据 PID 文件路径推导 shutdown token 文件路径 */
function tokenPath(pidPath: string): string {
  return pidPath.replace(/\.pid$/, '.shutdown.token');
}

/** 检测是否已有实例运行，返回 PidInfo 或 null */
export function checkExistingProcess(pidPath: string): PidInfo | null {
  if (!fs.existsSync(pidPath)) return null;
  try {
    const content = fs.readFileSync(pidPath, 'utf8');
    const info = JSON.parse(content);
    // 校验 pid 为正整数
    if (!Number.isInteger(info.pid) || info.pid <= 0) {
      fs.unlinkSync(pidPath);
      return null;
    }
    if (isProcessAlive(info.pid)) {
      return info as PidInfo;
    }
    // 进程已死，清理残留 PID 文件
    fs.unlinkSync(pidPath);
    return null;
  } catch {
    return null;
  }
}

/**
 * 写入 PID 文件，并生成 shutdown token 写入同目录的 .shutdown.token 文件。
 * token 文件权限设为 0o600，仅允许当前用户读取。
 * 返回生成的 token，供 health server 使用。
 */
export function writePidFile(pidPath: string, port: number): string {
  const info: PidInfo = { pid: process.pid, startTime: Date.now(), httpPort: port };
  // 限制仅所有者可读写，防止多用户环境下 PID/端口信息泄露
  fs.writeFileSync(pidPath, JSON.stringify(info, null, 2), { mode: 0o600 });

  // 生成随机 shutdown token 并写入 token 文件
  const token = crypto.randomUUID();
  fs.writeFileSync(tokenPath(pidPath), token, { mode: 0o600 });

  return token;
}

/** 读取已存在的 shutdown token，不存在时返回 null */
export function readShutdownToken(pidPath: string): string | null {
  try {
    return fs.readFileSync(tokenPath(pidPath), 'utf8').trim();
  } catch {
    return null;
  }
}

/** 删除 PID 文件及对应的 shutdown token 文件 */
export function removePidFile(pidPath: string): void {
  try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  try { fs.unlinkSync(tokenPath(pidPath)); } catch { /* ignore */ }
}
