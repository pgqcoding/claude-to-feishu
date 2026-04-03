import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';

// mock getDiskFreeMb，避免测试环境执行 PowerShell 命令导致超时
vi.mock('../../src/utils/platform.js', () => ({
  getDiskFreeMb: vi.fn().mockReturnValue(1024),
  normalizePath: (p: string) => p,
  pathsEqual: (a: string, b: string) => a === b,
  isSubPath: (child: string, parent: string) => child.startsWith(parent),
  getConfigDir: () => '/tmp/.claude-to-feishu',
  getDataDir: () => '/tmp/.claude-to-feishu',
  isProcessAlive: () => false,
  killProcess: () => false,
}));

import { createHealthServer } from '../../src/daemon/health.js';

const VALID_TOKEN = 'test-shutdown-token-abc123';

/** 向本地 HTTP 服务发送请求并返回响应体字符串 */
function request(
  server: http.Server,
  method: string,
  path: string,
  headers?: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, method, path, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** 启动服务并绑定随机端口 */
function startServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

describe('createHealthServer', () => {
  let server: http.Server;

  afterEach(() => {
    if (server?.listening) {
      server.close();
    }
  });

  it('GET /health 飞书已连接 → 返回 status=ok 的 JSON', async () => {
    const startTime = Date.now() - 5000; // 模拟已运行 5 秒
    server = createHealthServer({
      startTime,
      getActiveQueryCount: () => 2,
      isFeishuConnected: () => true,
      getLastMessageAt: () => 1234567890,
      shutdownToken: VALID_TOKEN,
    });
    await startServer(server);

    const { status, body } = await request(server, 'GET', '/health');
    const json = JSON.parse(body);

    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.feishu_connected).toBe(true);
    expect(json.active_queries).toBe(2);
    expect(json.uptime_s).toBeGreaterThanOrEqual(4);
    expect(json.last_message_at).toBe(1234567890);
  });

  it('GET /health 飞书未连接 → 返回 status=degraded', async () => {
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => false,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
    });
    await startServer(server);

    const { body } = await request(server, 'GET', '/health');
    const json = JSON.parse(body);

    expect(json.status).toBe('degraded');
    expect(json.feishu_connected).toBe(false);
    expect(json.last_message_at).toBeNull();
  });

  it('POST /shutdown 携带正确 token → 返回 200 并触发 onShutdown 回调', async () => {
    const onShutdown = vi.fn();
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
      onShutdown,
    });
    await startServer(server);

    const { status, body } = await request(server, 'POST', '/shutdown', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    const json = JSON.parse(body);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    // onShutdown 在 finish 事件后异步触发，稍等一下
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('POST /shutdown 无 Authorization header → 返回 401', async () => {
    const onShutdown = vi.fn();
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
      onShutdown,
    });
    await startServer(server);

    const { status, body } = await request(server, 'POST', '/shutdown');
    const json = JSON.parse(body);

    expect(status).toBe(401);
    expect(json.ok).toBe(false);

    // onShutdown 不应被调用
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('POST /shutdown 携带错误 token → 返回 401', async () => {
    const onShutdown = vi.fn();
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
      onShutdown,
    });
    await startServer(server);

    const { status, body } = await request(server, 'POST', '/shutdown', {
      Authorization: 'Bearer wrong-token-xyz',
    });
    const json = JSON.parse(body);

    expect(status).toBe(401);
    expect(json.ok).toBe(false);

    // onShutdown 不应被调用
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('POST /shutdown 未配置 onShutdown → 验证通过后仅返回 200，不报错', async () => {
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
      // 不提供 onShutdown
    });
    await startServer(server);

    const { status } = await request(server, 'POST', '/shutdown', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    expect(status).toBe(200);
  });

  it('未知路由 → 返回 404', async () => {
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
    });
    await startServer(server);

    const { status } = await request(server, 'GET', '/unknown-path');
    expect(status).toBe(404);
  });

  it('GET /health 包含 memory_mb 字段（数值类型）', async () => {
    server = createHealthServer({
      startTime: Date.now(),
      getActiveQueryCount: () => 0,
      isFeishuConnected: () => true,
      getLastMessageAt: () => null,
      shutdownToken: VALID_TOKEN,
    });
    await startServer(server);

    const { body } = await request(server, 'GET', '/health');
    const json = JSON.parse(body);

    expect(typeof json.memory_mb).toBe('number');
    expect(json.memory_mb).toBeGreaterThan(0);
  });
});
