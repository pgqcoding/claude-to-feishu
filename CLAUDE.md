# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

claude-to-feishu（CTF）是一个后台守护进程，将 Claude Code Agent SDK 桥接到飞书（Feishu/Lark）即时通讯。用户在飞书中发送消息，daemon 通过 SDK 调用 Claude，将流式回复渲染为飞书消息卡片。面向独立开发者，CLI 和飞书共享同一个 Claude 会话上下文。

## 常用命令

```bash
npm run build          # esbuild 构建到 dist/（daemon.js + cli.js 两个入口）
npm run dev            # tsx 直接运行（开发模式）
npm start              # 运行构建产物 dist/daemon.js
npm test               # vitest run（全部测试）
npm run test:watch     # vitest watch
npm run test:coverage  # vitest + v8 覆盖率
npx vitest run tests/unit/card-builder.test.ts   # 运行单个测试文件
```

npm registry 使用 npmmirror（`--registry https://registry.npmmirror.com`）。

## 技术栈

- TypeScript（ESM，`"type": "module"`），构建目标 ES2022
- Node.js >= 20
- 测试：Vitest 4.x + @vitest/coverage-v8
- 构建：esbuild（`scripts/build.mjs`），外部依赖不打包：`@anthropic-ai/claude-agent-sdk`、`@larksuiteoapi/node-sdk`
- 飞书 SDK：`@larksuiteoapi/node-sdk`
- Claude SDK：`@anthropic-ai/claude-agent-sdk`

## 架构

```
飞书 WebSocket ──→ FeishuAdapter ──→ MessageHandler ──→ SdkBridge ──→ Claude Agent SDK
                   (事件过滤/去重)    (命令路由/查询)     (SDK 封装)
                                          ↕
                                    StreamRenderer ──→ FeishuSender ──→ 飞书 API
                                    (节流/降级渲染)     (发送/更新卡片)
```

### 入口与进程模型

- `src/cli.ts` — CLI 入口（`claude-to-feishu start/stop/status/restart/init`），构建后 esbuild 插入 shebang
- `src/daemon.ts` — daemon 入口，ESM main guard 保护，仅直接运行时启动
- `src/daemon/lifecycle.ts` — 组装所有依赖并启动 WebSocket 监听
- Windows 上 daemon 通过 VBS 脚本启动（`wscript`），避免控制台窗口闪现；Linux/macOS 用标准 `detached` spawn

### 关键设计模式

- **依赖注入**：`handler.ts` 通过 `HandlerDeps` 接口注入所有依赖，接口使用 `Pick<>` 缩窄到实际需要的方法，便于测试 mock
- **不可变类型**：所有接口字段使用 `readonly`，状态更新返回新对象
- **chatId 串行化**：`MessageHandler` 每个 chatId 维护一个 Promise 链，防止并发状态竞态
- **状态持久化**：`Store` 使用 JSON 文件 + `.tmp` 写前日志 + Promise 链串行写入，冷启动时自动从 tmp 恢复
- **飞书 API 限流**：`rate-limiter.ts` 实现令牌桶算法，`StreamRenderer` 500ms 节流更新卡片，>20KB 降级为纯文本分段
- **配置文件位置**：`~/.claude-to-feishu/`（由 `utils/platform.ts` 的 `getConfigDir()` 决定）

### 命令系统

命令定义在 `src/feishu/commands/` 下，每个文件导出纯函数。添加新命令的步骤：

1. 在 `src/feishu/commands/` 下创建文件，导出 handler 函数和格式化工具
2. 在 `src/feishu/commands/index.ts` 中 re-export
3. 在 `src/daemon/command-handlers.ts` 中导入并注册到 `COMMAND_HANDLERS` Map
4. `CommandContext` 提供 `chatId`、`args`、`deps`、`sendText` 等上下文

### 权限网关

`PermissionGateway` 拦截危险工具调用，通过飞书卡片按钮或 `/approve` 文本命令授权。白名单工具（`CTF_PERMISSION_ALLOW_LIST`）直接放行，支持通配模式如 `Bash(npm *)`。

## 测试

测试在 `tests/` 下分三层：`unit/`、`integration/`、`smoke/`。

- 覆盖率阈值配置在 `vitest.config.ts`：lines/functions/branches 均 >= 80%
- `src/daemon.ts` 排除在覆盖率统计之外
- 测试依赖注入 mock，不需要真实飞书/Claude 连接

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
