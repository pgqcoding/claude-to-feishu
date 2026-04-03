import type {
  FeishuCardContent,
  FeishuCardElement,
  FeishuMarkdownElement,
  FeishuButtonGroupElement,
  FeishuNoteElement,
} from '../types.js';

// 飞书卡片 JSON 上限 28KB（28 * 1024 = 28672 字节）。
// 卡片 JSON 结构本身约占 500~2000 字节，预留 12KB 给结构开销后，内容最多 16KB。
// 使用字节数而非字符数：中文 18000 字符 = 54000 字节，远超飞书限制。
const MAX_CARD_CONTENT_BYTES = 16_000;
const STREAMING_CURSOR = ' ▍';

interface StreamingCardOptions {
  readonly content: string;
  readonly projectAlias: string;
}

interface CompletedCardOptions {
  readonly content: string;
  readonly projectAlias: string;
}

interface PermissionCardOptions {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly requestId: string;
  readonly projectAlias: string;
}

interface DisabledPermissionCardOptions {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly result: 'allowed' | 'denied' | 'timeout';
  readonly projectAlias: string;
}

/** 构建流式渲染中的卡片 */
export function buildStreamingCard(options: StreamingCardOptions): FeishuCardContent {
  const truncatedContent = truncateContent(options.content);

  const elements: FeishuCardElement[] = [
    { tag: 'markdown', content: truncatedContent + STREAMING_CURSOR } as FeishuMarkdownElement,
    { tag: 'hr' } as FeishuCardElement,
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '⏳ 生成中...' }],
    } as FeishuNoteElement,
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[${options.projectAlias}] Claude` },
      template: 'blue',
    },
    elements,
  };
}

/** 构建完成态卡片 */
export function buildCompletedCard(options: CompletedCardOptions): FeishuCardContent {
  const truncatedContent = truncateContent(options.content);

  const elements: FeishuCardElement[] = [
    { tag: 'markdown', content: truncatedContent } as FeishuMarkdownElement,
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[${options.projectAlias}] Claude` },
      template: 'green',
    },
    elements,
  };
}

/** 构建工具授权卡片（带允许/拒绝按钮） */
export function buildPermissionCard(options: PermissionCardOptions): FeishuCardContent {
  const inputSummary = formatToolInput(options.toolInput);

  const elements: FeishuCardElement[] = [
    {
      tag: 'markdown',
      content: `**🔧 工具调用请求: ${options.toolName}**\n\n\`\`\`json\n${inputSummary}\n\`\`\``,
    } as FeishuMarkdownElement,
    { tag: 'hr' } as FeishuCardElement,
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 允许' },
          type: 'primary',
          value: { action: 'allow', requestId: options.requestId },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 拒绝' },
          type: 'danger',
          value: { action: 'deny', requestId: options.requestId },
        },
      ],
    } as FeishuButtonGroupElement,
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[${options.projectAlias}] 工具授权` },
      template: 'orange',
    },
    elements,
  };
}

/** 构建已响应的授权卡片（按钮不可点击） */
export function buildDisabledPermissionCard(options: DisabledPermissionCardOptions): FeishuCardContent {
  const statusMap = {
    allowed: '✅ 已允许',
    denied: '❌ 已拒绝',
    timeout: '⏰ 已超时',
  } as const;

  const statusText = statusMap[options.result];
  const inputSummary = formatToolInput(options.toolInput);

  const elements: FeishuCardElement[] = [
    {
      tag: 'markdown',
      content: `**🔧 工具调用: ${options.toolName}** — ${statusText}\n\n\`\`\`json\n${inputSummary}\n\`\`\``,
    } as FeishuMarkdownElement,
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[${options.projectAlias}] 工具授权` },
      template: options.result === 'allowed' ? 'green' : 'red',
    },
    elements,
  };
}

// 卡片固定结构（header、config、hr、note、action 等）的字节开销上限
const CARD_STRUCT_OVERHEAD_BYTES = 2_000;

/** 估算卡片 JSON 大小（字节）
 *
 * 近似算法：取第一个 markdown element 的 content 字节数 + 固定结构开销。
 * 避免完整 JSON.stringify，减少 GC 压力（调用方发送前 SDK 还会再做一次序列化）。
 * 误差在 1~2KB 以内，不影响 20KB 阈值的判断准确性。
 */
export function estimateCardSize(card: FeishuCardContent): number {
  const mdElement = card.elements.find(
    (e): e is FeishuMarkdownElement => e.tag === 'markdown',
  );
  const contentBytes = mdElement
    ? Buffer.byteLength(mdElement.content, 'utf8')
    : 0;
  return contentBytes + CARD_STRUCT_OVERHEAD_BYTES;
}

function truncateContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= MAX_CARD_CONTENT_BYTES) {
    return content;
  }
  // 逐步向前截断，直到字节数满足限制
  // 使用二分法减少迭代次数
  const suffix = '\n\n...(内容过长，已截断)';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const targetBytes = MAX_CARD_CONTENT_BYTES - suffixBytes;

  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (Buffer.byteLength(content.slice(0, mid), 'utf8') <= targetBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return content.slice(0, lo) + suffix;
}

function formatToolInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, null, 2);
  if (json.length > 2000) {
    return json.slice(0, 2000) + '\n... (已截断)';
  }
  return json;
}
