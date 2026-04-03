# claude-to-feishu

A Node.js daemon that bridges Claude Code Agent SDK to Feishu (Lark) instant messaging. Send messages in Feishu, get streaming Claude responses rendered as interactive message cards.

Designed for solo developers who work with Claude CLI on desktop and want to continue conversations on mobile via Feishu — full relay mode with shared session context.

## Features

- **CLI ↔ Feishu 接力模式**：CLI 和飞书共享同一个 Claude 会话，上下文完整，随时切换端
- **流式输出**：Claude 回复实时渲染为飞书消息卡片，支持节流和降级渲染
- **权限网关**：工具调用需审批，通过 `/approve` 命令在飞书侧授权
- **多会话管理**：支持多项目会话，`/switch` 快速切换，`/fork` 创建分支
- **入站限流**：每用户每分钟消息数限制，防止意外消耗
- **WebSocket 模式**：无需公网地址，本地 daemon 主动连接飞书，自动重连

## Prerequisites

1. **Node.js >= 20**
2. **Claude Code CLI** 已安装并完成 API 认证（`claude --version` 验证）
3. **飞书企业自建应用**，需开启以下权限：
   - `im:message` — 发送/接收私聊消息
   - `im:message.create` — 创建/更新消息
   - `im:message:receive_v1` — 接收消息事件
4. 飞书应用使用 **WebSocket 模式**（无需配置 Webhook URL）

## Installation

```bash
npm install -g claude-to-feishu
```

或从源码构建：

```bash
git clone https://github.com/pgqcoding/claude-to-feishu.git
cd claude-to-feishu
npm install
npm run build
```

## Configuration

配置文件位于 `~/.claude-to-feishu/config.env`，首次运行时自动创建模板。

```bash
# 必填
CTF_FEISHU_APP_ID=cli_xxxxxxxxxx        # 飞书应用 ID
CTF_FEISHU_APP_SECRET=xxxxxxxx          # 飞书应用密钥
CTF_ALLOWED_USERS=ou_xxxxxxxx           # 允许的用户 open_id，分号分隔
CTF_ALLOWED_DIRS=/path/to/project-a;/path/to/project-b  # 允许操作的目录

# 可选
CTF_DIR_ALIASES=project-a=/path/to/project-a  # 目录别名，用于 /new 命令
CTF_DEFAULT_MODEL=sonnet                # 默认模型（sonnet/opus/haiku）
CTF_PERMISSION_ALLOW_LIST=Read;Glob     # 无需审批的工具白名单
CTF_MAX_CONCURRENT_QUERIES=3            # 最大并发查询数
CTF_QUERY_TIMEOUT_MS=600000             # 查询超时（毫秒）
CTF_INBOUND_RATE_LIMIT=20               # 每用户每分钟消息限制
```

完整配置项见 [`config.env.example`](./config.env.example)。

飞书应用的 open_id 获取方式：以目标账号向机器人发送任意消息，daemon 日志中会打印发送者的 open_id。

## Usage

### CLI Commands

```bash
claude-to-feishu start    # 启动 daemon（后台运行）
claude-to-feishu stop     # 停止 daemon
claude-to-feishu status   # 查看 daemon 状态
claude-to-feishu restart  # 重启 daemon
```

### Feishu Commands

在飞书中直接发送文本与 Claude 对话。以下命令用于管理会话：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/new [别名]` | 无参数列出可用项目目录，有参数创建新会话 |
| `/list` | 列出可用会话（按最近活跃排序） |
| `/sessions [refresh]` | 增强版会话列表，含状态标记 |
| `/switch <序号/id>` | 切换到指定会话 |
| `/status` | 查看当前绑定状态 |
| `/model [名称]` | 查看或切换模型（sonnet/opus/haiku） |
| `/history` | 查看当前会话详情 |
| `/fork` | 基于当前会话创建分支会话 |
| `/resume <id前缀或序号>` | 恢复历史会话 |
| `/retry` | 重试上次失败的查询 |
| `/stop` | 终止当前正在进行的查询 |
| `/approve` | 批准最新待处理的工具调用权限请求 |

### CLI ↔ Feishu 接力

```
# 在 CLI 中开始一个会话
claude --session-id abc123

# 在飞书中接力
/list              # 查看可用会话
/switch abc123     # 切换到该会话并继续对话

# 回到 CLI
claude --resume abc123
```

## Architecture

```
飞书 WebSocket
      │
      ▼
FeishuAdapter          事件过滤、去重、用户白名单校验
      │
      ▼
MessageHandler         命令路由（/xxx）和普通消息分发
      │
      ▼
SdkBridge              封装 @anthropic-ai/claude-agent-sdk，管理查询生命周期
      │
      ├── PermissionGateway    工具调用审批（白名单放行 / 飞书卡片审批）
      │
      ▼
StreamRenderer         流式输出节流、降级渲染
      │
      ▼
FeishuSender           发送/更新飞书消息卡片（REST API）
```

状态存储：JSON 文件，位于 `~/.claude-to-feishu/`。

## Development

```bash
npm run build          # esbuild 构建
npm run dev            # watch 模式
npm test               # Vitest 单元测试
npm run test:coverage  # 覆盖率报告
```

核心模块测试覆盖率 >= 80%。集成测试见 `tests/integration/`。

## License

MIT
