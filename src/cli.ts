/**
 * CLI 入口 — 跨平台 daemon 管理命令
 * shebang 由 build.mjs 在构建后插入
 *
 * 用法：
 *   claude-to-feishu start    启动 daemon（后台运行）
 *   claude-to-feishu stop     停止 daemon
 *   claude-to-feishu status   查看 daemon 状态
 *   claude-to-feishu restart  重启 daemon
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDataDir } from './utils/platform.js';
import { checkExistingProcess, removePidFile } from './daemon/pid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = getDataDir();
const PID_PATH = path.join(DATA_DIR, 'daemon.pid');
const LOG_DIR = path.join(DATA_DIR, 'logs');

// daemon.js 与 cli.js 同目录（esbuild 构建到 dist/）
const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

const ACTIONS = ['start', 'stop', 'status', 'restart'] as const;
type Action = (typeof ACTIONS)[number];

function printUsage(): void {
  console.log(`用法：claude-to-feishu <start|stop|status|restart>`);
}

/** 等待 PID 文件出现，最多等 waitSec 秒 */
async function waitForPidFile(waitSec: number): Promise<boolean> {
  for (let i = 0; i < waitSec * 10; i++) {
    if (fs.existsSync(PID_PATH)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function startDaemon(): Promise<void> {
  const existing = checkExistingProcess(PID_PATH);
  if (existing) {
    console.log(`[INFO] daemon 已在运行 (PID: ${existing.pid}, Port: ${existing.httpPort})`);
    return;
  }

  // 清理残留 PID 文件
  if (fs.existsSync(PID_PATH)) {
    removePidFile(PID_PATH);
  }

  // 确保日志目录存在
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // 检查 daemon.js 是否存在
  if (!fs.existsSync(DAEMON_ENTRY)) {
    console.error(`[ERROR] ${DAEMON_ENTRY} 不存在，请先运行 npm run build`);
    process.exit(1);
  }

  const bootLog = path.join(LOG_DIR, 'daemon-boot.log');
  const bootErrLog = path.join(LOG_DIR, 'daemon-boot-err.log');
  const outFd = fs.openSync(bootLog, 'a');
  const errFd = fs.openSync(bootErrLog, 'a');

  // 后台启动 daemon 进程，父进程退出后子进程继续运行
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=640', '--expose-gc', DAEMON_ENTRY],
    {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env },
    },
  );
  child.unref();

  console.log(`[INFO] daemon 已启动 (PID: ${child.pid})`);

  // 等待 PID 文件生成（最多 10 秒）
  const ok = await waitForPidFile(10);
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  if (ok) {
    const content = JSON.parse(fs.readFileSync(PID_PATH, 'utf8'));
    console.log(`[INFO] Health: http://127.0.0.1:${content.httpPort}/health`);
  } else {
    console.warn('[WARN] 等待超时，PID 文件未生成。查看启动日志：');
    console.warn(`  ${bootLog}`);
    console.warn(`  ${bootErrLog}`);
  }
}

async function stopDaemon(): Promise<void> {
  const existing = checkExistingProcess(PID_PATH);
  if (!existing) {
    console.log('[INFO] daemon 未在运行');
    return;
  }

  // 尝试 HTTP shutdown
  const tokenFile = path.join(DATA_DIR, 'daemon.shutdown.token');
  let stopped = false;
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${existing.httpPort}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log('[INFO] shutdown 信号已发送');
      stopped = true;
    }
  } catch {
    // HTTP shutdown 失败，降级到 kill
  }

  if (!stopped) {
    console.log('[WARN] HTTP shutdown 失败，强制终止进程');
    try { process.kill(existing.pid, 'SIGTERM'); } catch { /* ignore */ }
  }

  // 等待进程退出（最多 10 秒）
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(existing.pid, 0); // 仅检测，不发信号
    } catch {
      break; // 进程已退出
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 强制终止 + 清理
  try { process.kill(existing.pid, 'SIGKILL'); } catch { /* ignore */ }
  removePidFile(PID_PATH);
  console.log('[INFO] daemon 已停止');
}

async function showStatus(): Promise<void> {
  const existing = checkExistingProcess(PID_PATH);
  if (!existing) {
    console.log('[INFO] daemon 未运行');
    return;
  }

  console.log(`[INFO] daemon 运行中 (PID: ${existing.pid}, Port: ${existing.httpPort})`);

  try {
    const res = await fetch(`http://127.0.0.1:${existing.httpPort}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const health = await res.json();
    console.log(JSON.stringify(health, null, 2));
  } catch {
    console.warn('[WARN] health 端点不可达');
  }
}

// --- main ---
const action = process.argv[2] as Action | undefined;

if (!action || !ACTIONS.includes(action)) {
  printUsage();
  process.exit(action ? 1 : 0);
}

switch (action) {
  case 'start':
    await startDaemon();
    break;
  case 'stop':
    await stopDaemon();
    break;
  case 'status':
    await showStatus();
    break;
  case 'restart':
    await stopDaemon();
    await startDaemon();
    break;
}
