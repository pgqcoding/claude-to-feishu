/**
 * 飞书联调烟雾测试脚本
 *
 * 验证飞书 API 权限和功能：
 * 1. 发送卡片消息
 * 2. PATCH 更新卡片
 * 3. 按钮点击授权卡片（手动确认）
 * 4. 流式更新 5 次（验证不触发 429）
 *
 * 运行方式：
 *   npx tsx scripts/feishu-smoke.ts
 *   SMOKE_TEST_CHAT_ID=oc_xxx npx tsx scripts/feishu-smoke.ts
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ===== 类型定义 =====

interface SmokeResult {
  readonly label: string;
  readonly passed: boolean;
  readonly note?: string;
}

// ===== 环境加载 =====

/**
 * 从项目配置目录加载 config.env，优先使用环境变量中已有的值
 */
function loadEnv(): void {
  // 尝试从 ~/.config/claude-to-feishu/config.env 加载
  const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  const configPaths = [
    path.join(homeDir, '.config', 'claude-to-feishu', 'config.env'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.env'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      dotenvConfig({ path: configPath, override: false });
      break;
    }
  }
}

// ===== 飞书客户端初始化 =====

function createClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({ appId, appSecret });
}

// ===== 卡片构建（内联，不依赖 src 层避免模块解析问题） =====

function buildTestCard(content: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '[烟雾测试] 飞书 API 验证' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content },
    ],
  };
}

function buildPermissionTestCard(requestId: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '[烟雾测试] 按钮回调验证' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: '**🔧 工具调用请求: Bash**\n\n```json\n{\n  "command": "echo hello"\n}\n```\n\n请点击下方按钮完成手动验证。',
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { action: 'allow', requestId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'deny', requestId },
          },
        ],
      },
    ],
  };
}

// ===== 工具函数 =====

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 格式化错误信息，提取关键内容 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    // 飞书 SDK 错误通常有 code 和 msg
    if (e['code'] !== undefined || e['msg'] !== undefined) {
      return `code=${e['code']} msg=${e['msg']}`;
    }
    if (e['message'] !== undefined) {
      return String(e['message']);
    }
  }
  return String(err);
}

// ===== 测试步骤 =====

/**
 * [1/4] 发送卡片消息
 */
async function testSendCard(
  client: lark.Client,
  chatId: string,
  receiveIdType: string,
): Promise<{ passed: boolean; messageId: string; note?: string }> {
  console.log('\n[1/4] 发送卡片消息...');
  console.log(`  → 发送到 chat_id: ${chatId}`);

  try {
    const card = buildTestCard('**烟雾测试**：卡片消息发送验证\n\n时间：' + new Date().toLocaleString('zh-CN'));
    const resp = await client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      params: { receive_id_type: receiveIdType as 'chat_id' },
    });

    const messageId = resp?.data?.message_id ?? '';
    if (!messageId) {
      console.log('  ❌ 发送成功但未返回 message_id');
      return { passed: false, messageId: '', note: '未返回 message_id' };
    }

    console.log(`  ✅ 卡片发送成功 (message_id: ${messageId})`);
    return { passed: true, messageId };
  } catch (err) {
    const note = formatError(err);
    console.log(`  ❌ 发送失败: ${note}`);
    return { passed: false, messageId: '', note };
  }
}

/**
 * [2/4] PATCH 更新卡片（验证 im:message:patch 权限）
 */
async function testPatchCard(
  client: lark.Client,
  messageId: string,
): Promise<{ passed: boolean; note?: string }> {
  console.log('\n[2/4] PATCH 更新卡片...');

  if (!messageId) {
    console.log('  ⚠️ 跳过（上一步未获得 message_id）');
    return { passed: false, note: '无 message_id' };
  }

  console.log(`  → 更新 message_id: ${messageId}`);

  try {
    const updatedCard = buildTestCard(
      '**烟雾测试**：卡片已更新 ✅\n\n更新时间：' + new Date().toLocaleString('zh-CN'),
    );
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(updatedCard),
      },
    });

    console.log('  ✅ 卡片更新成功');
    return { passed: true };
  } catch (err) {
    const note = formatError(err);
    console.log(`  ❌ 更新失败: ${note}`);
    console.log('  💡 请确认应用已开启 im:message:patch 权限');
    return { passed: false, note };
  }
}

/**
 * [3/4] 按钮点击授权卡片（手动确认，不等待回调）
 */
async function testButtonCard(
  client: lark.Client,
  chatId: string,
  receiveIdType: string,
): Promise<{ passed: boolean; note?: string }> {
  console.log('\n[3/4] 按钮点击回调...');

  const requestId = `smoke-test-${Date.now()}`;

  try {
    const card = buildPermissionTestCard(requestId);
    const resp = await client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      params: { receive_id_type: receiveIdType as 'chat_id' },
    });

    const messageId = resp?.data?.message_id ?? '';
    console.log(`  → 已发送授权卡片（工具: Bash, 命令: echo hello）`);
    if (messageId) {
      console.log(`  → message_id: ${messageId}`);
    }
    console.log('  → ⏳ 请在飞书中点击「允许」或「拒绝」按钮...');
    console.log('  → 脚本不等待回调（需确保应用订阅了 card.action.trigger 事件）');
    console.log('  ⚠️ 需手动确认：点击按钮后查看应用日志，验证 card.action.trigger 事件是否到达');

    return {
      passed: true,
      note: '已发送授权卡片，需手动点击并检查回调',
    };
  } catch (err) {
    const note = formatError(err);
    console.log(`  ❌ 授权卡片发送失败: ${note}`);
    return { passed: false, note };
  }
}

/**
 * [4/4] 流式更新 5 次（间隔 300ms，验证不触发 429）
 */
async function testStreamingUpdates(
  client: lark.Client,
  messageId: string,
): Promise<{ passed: boolean; note?: string }> {
  console.log('\n[4/4] 流式更新 5 次（间隔 300ms）...');

  if (!messageId) {
    console.log('  ⚠️ 跳过（第 1 步未获得 message_id，使用临时卡片）');
    return { passed: false, note: '无 message_id' };
  }

  const errors: string[] = [];

  for (let i = 1; i <= 5; i++) {
    try {
      const card = buildTestCard(
        `**流式更新测试** — 第 ${i}/5 次\n\n${'█'.repeat(i * 4)}${'░'.repeat((5 - i) * 4)}\n\n时间：${new Date().toLocaleString('zh-CN')}`,
      );
      await client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
        },
      });
      console.log(`  → 更新 ${i}/5 ✅`);
    } catch (err) {
      const note = formatError(err);
      console.log(`  → 更新 ${i}/5 ❌ (${note})`);
      errors.push(`第 ${i} 次: ${note}`);
    }

    // 最后一次不需要等待
    if (i < 5) {
      await sleep(300);
    }
  }

  if (errors.length === 0) {
    console.log('  ✅ 连续更新无 429 错误');
    return { passed: true };
  } else {
    const note = errors.join('; ');
    console.log(`  ❌ ${errors.length} 次更新失败`);
    if (errors.some((e) => e.includes('429') || e.includes('rate'))) {
      console.log('  💡 检测到限流错误，可能需要增大更新间隔');
    }
    return { passed: false, note };
  }
}

// ===== 主流程 =====

async function main(): Promise<void> {
  console.log('🔥 飞书联调烟雾测试');
  console.log('====================');

  // 加载环境变量
  loadEnv();

  // 读取必要配置
  const appId = process.env['CTF_FEISHU_APP_ID'] ?? '';
  const appSecret = process.env['CTF_FEISHU_APP_SECRET'] ?? '';
  // 支持命令行参数或环境变量传入 chat_id 或 open_id
  const chatId = process.argv[2] ?? process.env['SMOKE_TEST_CHAT_ID'] ?? '';

  // 校验必要参数
  const missingVars: string[] = [];
  if (!appId) missingVars.push('CTF_FEISHU_APP_ID');
  if (!appSecret) missingVars.push('CTF_FEISHU_APP_SECRET');
  if (!chatId) missingVars.push('SMOKE_TEST_CHAT_ID（或命令行第一个参数）');

  // 根据 ID 前缀自动判断类型
  type ReceiveIdType = 'chat_id' | 'open_id' | 'union_id' | 'user_id' | 'email';
  const receiveIdType: ReceiveIdType = chatId.startsWith('ou_')
    ? 'open_id'
    : chatId.startsWith('on_')
      ? 'union_id'
      : 'chat_id';

  if (missingVars.length > 0) {
    console.error('\n❌ 缺少必要配置：');
    for (const v of missingVars) {
      console.error(`  - ${v}`);
    }
    console.error('\n示例：');
    console.error('  SMOKE_TEST_CHAT_ID=oc_xxx npx tsx scripts/feishu-smoke.ts');
    console.error('  npx tsx scripts/feishu-smoke.ts oc_xxx');
    process.exit(1);
  }

  console.log(`\nApp ID          : ${appId.slice(0, 8)}***`);
  console.log(`Receive ID      : ${chatId}`);
  console.log(`Receive ID Type : ${receiveIdType}`);

  const client = createClient(appId, appSecret);

  // 收集结果
  const results: SmokeResult[] = [];

  // [1/4] 发送卡片
  const step1 = await testSendCard(client, chatId, receiveIdType);
  results.push({ label: '发送卡片消息', passed: step1.passed, note: step1.note });

  // [2/4] PATCH 更新卡片（复用第 1 步的 message_id）
  const step2 = await testPatchCard(client, step1.messageId);
  results.push({ label: 'PATCH 更新卡片', passed: step2.passed, note: step2.note });

  // [3/4] 按钮授权卡片
  const step3 = await testButtonCard(client, chatId, receiveIdType);
  // 按钮测试属于"手动确认"，不计入失败（仅检查卡片能否发出去）
  results.push({ label: '按钮点击回调', passed: step3.passed, note: step3.note });

  // [4/4] 流式更新（复用第 1 步的 message_id）
  const step4 = await testStreamingUpdates(client, step1.messageId);
  results.push({ label: '流式更新 5 次', passed: step4.passed, note: step4.note });

  // 输出汇总
  console.log('\n====================');
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const noteStr = r.note ? ` — ${r.note}` : '';
    console.log(`  ${icon} ${r.label}${noteStr}`);
  }

  console.log(`\n结果: ${passed}/${total} 通过`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n未捕获的异常:', err);
  process.exit(1);
});
