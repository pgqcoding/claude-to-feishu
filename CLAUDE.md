# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

claude-to-feishu（CTF）是一个后台守护进程，将 Claude Code Agent SDK 桥接到飞书（Feishu/Lark）即时通讯。用户在飞书中发送消息，daemon 通过 SDK 调用 Claude，将流式回复渲染为飞书消息卡片。

## 常用命令

```bash
npm run build          # esbuild 构建到 dist/
npm run dev            # tsx 直接运行（开发模式）
npm start              # 运行构建产物 dist/daemon.js
npm test               # vitest run（全部测试）
npm run test:watch     # vitest watch
npm run test:coverage  # vitest + v8 覆盖率
npx vitest run tests/unit/card-builder.test.ts   # 运行单个测试文件
```

npm registry 使用 npmmirror（`--registry https://registry.npmmirror.com`）。

## 技术栈

- TypeScript（ESM，`"type": "module"`）
- Node.js >= 20，构建目标 ES2022
- 测试：Vitest 4.x + @vitest/coverage-v8
- 构建：esbuild（`scripts/build.mjs`）
- 飞书 SDK：`@larksuiteoapi/node-sdk`
- Claude SDK：`@anthropic-ai/claude-agent-sdk`

## 架构

```
飞书 WebSocket ──→ FeishuAdapter ──→ MessageHandler ──→ SdkBridge ──→ Claude CLI
                   (事件过滤/去重)    (命令路由/查询)     (SDK 封装)
                                          ↕
                                    StreamRenderer ──→ FeishuSender ──→ 飞书 API
                                    (节流/降级渲染)     (发送/更新卡片)
```

### 核心模块

- **`src/daemon/lifecycle.ts`** — 守护进程启动入口，组装所有依赖并启动 WebSocket 监听
- **`src/daemon/handler.ts`** — 消息处理器，解析命令/普通消息，每个 chatId 串行执行（Promise 链）
- **`src/daemon/command-handlers.ts`** — 命令路由表（`/help`, `/sessions`, `/model` 等）
- **`src/core/sdk-bridge.ts`** — Claude Agent SDK 封装，支持同步查询和流式查询（`queryStream`）
- **`src/core/session-manager.ts`** — 会话管理（列表、切换、绑定），带 30s TTL 缓存
- **`src/core/permission-gateway.ts`** — 工具授权网关，拦截危险工具调用，通过飞书卡片按钮授权/拒绝
- **`src/feishu/adapter.ts`** — 飞书事件适配器，处理消息去重、用户白名单过滤、非文本消息拒绝
- **`src/feishu/stream-renderer.ts`** — 流式渲染器，500ms 节流更新卡片，>20KB 降级为纯文本分段
- **`src/feishu/card-builder.ts`** — 飞书消息卡片构建（流式进度卡、权限请求卡、完成卡等）
- **`src/feishu/sender.ts`** — 飞书消息发送封装，自动处理长消息分段
- **`src/config.ts`** — 配置加载与校验，环境变量前缀 `CTF_`，配置文件 `~/.claude-to-feishu/config.env`

### 飞书命令系统

命令定义在 `src/feishu/commands/` 下，每个文件导出一个 handler，通过 `command-handlers.ts` 注册路由。支持的命令包括 `/help`, `/sessions`, `/model`, `/history`, `/fork`, `/resume`, `/retry` 等。

### 数据流

1. 飞书 WebSocket 推送事件 → `FeishuAdapter.handleEvent()` 过滤/去重
2. → `MessageHandler.processMessage()` 解析命令或普通消息
3. 普通消息 → `SdkBridge.queryStream()` 流式调用 Claude
4. 流式 chunk → `StreamRenderer.appendChunk()` 节流合并后 PATCH 更新飞书卡片
5. 工具调用 → `PermissionGateway.requestPermission()` 发送授权卡片，等待用户点击

### 关键设计决策

- **依赖注入**：`handler.ts` 通过 `HandlerDeps` 接口注入所有依赖，便于测试 mock
- **不可变类型**：所有接口字段使用 `readonly`，状态更新返回新对象
- **飞书 API 限流**：`rate-limiter.ts` 实现令牌桶算法，`StreamRenderer` 在限流时降级
- **配置文件位置**：`~/.claude-to-feishu/`（由 `utils/platform.ts` 的 `getConfigDir()` 决定）

## 测试

测试在 `tests/` 下分三层：`unit/`、`integration/`、`smoke/`。核心模块覆盖率要求 >= 80%。

## 开发规范

- 提交信息：中文，格式 `<type>: <description>`
- 注释：中文
- 环境变量前缀：`CTF_`
- 配置参考：`config.env.example`

## 任务执行策略（强制）

当有多个 task 需要执行时：

1. **并行优先**：无依赖的 task 全部启动 subagent 并行执行
2. **主会话只做编排**：主会话负责任务拆分、subagent 调度、结果汇总，不直接执行具体编码工作
3. **避免上下文膨胀**：禁止在主会话中串行处理多个 task
