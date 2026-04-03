// daemon 入口 — ESM main guard 保护
import { fileURLToPath } from 'node:url';

// 重新导出子模块，供外部引用
export { createHealthServer } from './daemon/health.js';
export { createMessageHandler } from './daemon/handler.js';
export { checkExistingProcess, writePidFile, removePidFile } from './daemon/pid.js';

// 仅直接运行时启动 daemon
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const { createDaemon } = await import('./daemon/lifecycle.js');
  createDaemon().catch((err: Error) => {
    console.error('daemon 启动失败:', err.message);
    process.exit(1);
  });
}
