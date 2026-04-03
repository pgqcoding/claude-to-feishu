import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

const IS_WINDOWS = os.platform() === 'win32';

/** 规范化路径：resolve + 去尾部斜杠 + Windows 下转小写 */
export function normalizePath(p: string): string {
  let resolved = path.resolve(p);
  while (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.slice(0, -1);
  }
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** 路径相等比较（Windows 大小写不敏感） */
export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** 解析真实路径，对不存在的路径回退到 path.resolve（防符号链接绕过） */
function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 检查 child 是否是 parent 的子路径（防路径遍历 + 防符号链接绕过） */
export function isSubPath(child: string, parent: string): boolean {
  const resolvedChild = IS_WINDOWS ? resolveRealPath(child).toLowerCase() : resolveRealPath(child);
  const resolvedParent = IS_WINDOWS ? resolveRealPath(parent).toLowerCase() : resolveRealPath(parent);
  const sep = IS_WINDOWS ? '\\' : '/';
  return resolvedChild === resolvedParent ||
         resolvedChild.startsWith(resolvedParent + sep);
}

/** 获取配置目录路径 */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.claude-to-feishu');
}

/** 获取数据目录路径（与配置目录相同） */
export function getDataDir(): string {
  return getConfigDir();
}

/** 检测进程是否存活（跨平台） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 强制终止进程（跨平台） */
export function killProcess(pid: number): boolean {
  try {
    if (IS_WINDOWS) {
      // 使用 execFileSync 避免 shell 注入；windowsHide: true 防止弹出 CLI 窗口
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

/** 检测磁盘剩余空间（MB） */
export function getDiskFreeMb(dir: string): number | null {
  try {
    if (IS_WINDOWS) {
      const drive = path.parse(dir).root.replace('\\', '');
      const driveLetter = drive.replace(':', '');
      // 严格校验：只允许单个英文字母，防止命令注入
      if (!/^[A-Za-z]$/.test(driveLetter)) {
        return null;
      }
      // 使用 execFileSync 传参数组，避免 shell 注入；windowsHide: true 防止弹出 CLI 窗口
      const output = execFileSync(
        'powershell',
        ['-Command', `(Get-PSDrive ${driveLetter}).Free`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      ).trim();
      return Math.floor(parseInt(output, 10) / 1024 / 1024);
    } else {
      // 使用 execFileSync 避免 shell 注入，手动解析 df 输出
      const output = execFileSync('df', ['-m', dir], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      // df 输出格式：首行为表头，末行为目标目录数据，第 4 列为可用空间
      const lines = output.split('\n');
      const lastLine = lines[lines.length - 1];
      const available = lastLine.trim().split(/\s+/)[3];
      return parseInt(available ?? '', 10);
    }
  } catch {
    return null;
  }
}
