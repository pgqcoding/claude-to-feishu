import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HealthResponse } from '../types.js';
import { getDiskFreeMb } from '../utils/platform.js';

interface HealthContext {
  readonly startTime: number;
  readonly getActiveQueryCount: () => number;
  readonly isFeishuConnected: () => boolean;
  readonly getLastMessageAt: () => number | null;
  /** shutdown 鉴权 token，POST /shutdown 必须携带此 token */
  readonly shutdownToken: string;
  /** 收到 POST /shutdown 时触发优雅关闭，可选 */
  readonly onShutdown?: () => void;
  /** 用于计算磁盘剩余空间的目录，默认为 process.cwd() */
  readonly diskCheckDir?: string;
}

/** 从 Authorization header 解析 Bearer token */
function parseBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** 创建 /health 和 /shutdown 端点的 HTTP 服务器 */
export function createHealthServer(ctx: HealthContext): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const uptimeS = Math.floor((Date.now() - ctx.startTime) / 1000);
      const memoryMb = Math.floor(process.memoryUsage.rss() / 1024 / 1024);

      // H5: 填充 disk_free_mb
      const diskFreeMb = getDiskFreeMb(ctx.diskCheckDir ?? process.cwd()) ?? undefined;

      const body: HealthResponse = {
        status: ctx.isFeishuConnected() ? 'ok' : 'degraded',
        uptime_s: uptimeS,
        active_queries: ctx.getActiveQueryCount(),
        feishu_connected: ctx.isFeishuConnected(),
        last_message_at: ctx.getLastMessageAt(),
        memory_mb: memoryMb,
        disk_free_mb: diskFreeMb,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // POST /shutdown：验证 Bearer token，通过后触发优雅关闭（Windows 下 SIGTERM 不可靠的降级方案）
    if (req.method === 'POST' && req.url === '/shutdown') {
      const token = parseBearerToken(req.headers['authorization']);

      // 使用恒定时间比较防止计时攻击，长度不同时直接拒绝
      const tokenMatch = token !== null &&
        token.length === ctx.shutdownToken.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(ctx.shutdownToken));
      if (!tokenMatch) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      if (ctx.onShutdown) {
        // 等响应写完再关闭，避免客户端收不到 200
        res.on('finish', () => ctx.onShutdown!());
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return server;
}
