/** 帮助文本：列出所有可用命令 */
export const HELP_TEXT = `📋 可用命令：
/list — 列出可用会话（按最近活跃排序）
/sessions [refresh] — 增强版会话列表（含状态标记，refresh 强制刷新）
/switch <序号/id> — 切换到指定会话
/new [别名] — 无参数列出项目目录，有参数则创建新会话
/stop — 终止当前正在进行的查询
/status — 查看当前绑定状态
/history — 查看当前会话详情（标题、首次提问、活跃时间等）
/model [名称] — 查看/切换模型（sonnet/opus/haiku）
/retry — 重试上次失败的查询
/resume <id前缀或序号> — 恢复历史会话（如 /resume abc1 或 /resume 3）
/fork — 基于当前会话创建分支会话
/approve — 批准最新待处理的工具调用权限请求
/help — 显示此帮助信息

直接发送文本即可与当前绑定的 Claude 会话对话。`;

/** 欢迎文本：首次使用时展示 */
export const WELCOME_TEXT = `👋 欢迎使用 Claude-to-Feishu！

这是一个连接飞书和 Claude CLI 的桥接工具，支持：
• 飞书上与 Claude 对话
• 多项目会话管理
• CLI↔飞书双向接力

${HELP_TEXT}

请先用 /list 查看可用会话，或用 /new 创建新会话。`;
