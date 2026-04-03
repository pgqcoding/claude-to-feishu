import type { MessageContent, MessageSender, FeishuCardContent } from '../types.js';

/** 飞书 receive_id_type 枚举 */
type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

/** 飞书消息创建参数 */
interface FeishuMessageCreateParams {
  readonly data: {
    readonly receive_id: string;
    readonly msg_type: string;
    readonly content: string;
  };
  readonly params: { readonly receive_id_type: FeishuReceiveIdType };
}

/** 飞书消息更新参数 */
interface FeishuMessagePatchParams {
  readonly path: { readonly message_id: string };
  readonly data: { readonly msg_type: string; readonly content: string };
}

/** 飞书 API 响应 */
interface FeishuMessageResponse {
  readonly data?: { readonly message_id?: string };
}

/** 飞书 im.message 命名空间 */
interface FeishuImMessage {
  create(params: FeishuMessageCreateParams): Promise<FeishuMessageResponse>;
  patch(params: FeishuMessagePatchParams): Promise<unknown>;
}

/** 飞书 Reaction 创建参数 */
interface FeishuReactionCreateParams {
  readonly data: {
    readonly reaction_type: {
      readonly emoji_type: string;
    };
  };
  readonly path: {
    readonly message_id: string;
  };
}

/** 飞书 Reaction 删除参数 */
interface FeishuReactionDeleteParams {
  readonly path: {
    readonly message_id: string;
    readonly reaction_id: string;
  };
}

/** 飞书 Reaction API 响应 */
interface FeishuReactionResponse {
  readonly data?: {
    readonly reaction_id?: string;
    readonly reaction_type?: { readonly emoji_type?: string };
  };
}

/** 飞书 im.messageReaction 命名空间 */
interface FeishuImMessageReaction {
  create(params: FeishuReactionCreateParams): Promise<FeishuReactionResponse>;
  delete(params: FeishuReactionDeleteParams): Promise<unknown>;
}

/** 飞书 Client 最小接口——只描述实际调用到的方法 */
export interface FeishuClient {
  readonly im: {
    readonly message: FeishuImMessage;
    readonly messageReaction: FeishuImMessageReaction;
  };
}

/** 飞书安全字节阈值（飞书限制 4096 UTF-8 字节，预留空间给页码标识） */
const MAX_BYTES = 3800;
// 230001 是消息内容格式错误（非不可达），不应标记为 unreachable
const UNREACHABLE_ERROR_CODES = [230014];
/** 飞书限流错误码，遇到时不计入不可达失败计数 */
const RATE_LIMIT_ERROR_CODES = [99991400, 99991401, 99991403];
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 按 UTF-8 字节数分段消息，添加序号标识
 *
 * 飞书限制是 4096 UTF-8 字节（非字符数）。
 * 使用 Buffer.byteLength 计算，在字符边界处分段避免截断多字节字符。
 */
export function splitMessage(text: string, maxBytes: number = MAX_BYTES): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let byteCount = 0;
    while (end < text.length) {
      // 用 charCodeAt 判断字符宽度，避免逐字符调用 Buffer.byteLength（系统调用）
      const code = text.charCodeAt(end);
      let charBytes: number;
      if (code < 0x80) {
        charBytes = 1;
      } else if (code < 0x800) {
        charBytes = 2;
      } else if (code >= 0xD800 && code <= 0xDFFF) {
        // surrogate pair：高代理项 + 低代理项 = 4 字节，整体跳过
        charBytes = 4;
      } else {
        charBytes = 3;
      }
      if (byteCount + charBytes > maxBytes) break;
      byteCount += charBytes;
      // surrogate pair 占两个 code unit，一起推进
      end += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    }
    if (end === start) end = start + 1;
    segments.push(text.slice(start, end));
    start = end;
  }

  const total = segments.length;
  return segments.map((seg, i) => `[${i + 1}/${total}]\n${seg}`);
}

export class FeishuSender implements MessageSender {
  private readonly client: FeishuClient;
  private readonly unreachableChats = new Set<string>();
  private readonly failureCounts = new Map<string, number>();

  constructor(client: FeishuClient) {
    this.client = client;
  }

  async send(chatId: string, content: MessageContent): Promise<string> {
    if (this.unreachableChats.has(chatId)) {
      throw new Error(`chat ${chatId} 已标记为不可达`);
    }

    try {
      let messageId: string = '';
      if (content.type === 'text') {
        // 清理末尾换行符，避免飞书 API 230001 错误
        const cleanedText = content.text.trimEnd();
        const segments = splitMessage(cleanedText);
        for (const segment of segments) {
          const resp = await this.client.im.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: segment }),
            },
            params: { receive_id_type: 'chat_id' },
          });
          messageId = resp?.data?.message_id ?? '';
        }
        this.failureCounts.delete(chatId);
        return messageId;
      } else {
        const resp = await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(content.card),
          },
          params: { receive_id_type: 'chat_id' },
        });
        this.failureCounts.delete(chatId);
        return resp?.data?.message_id ?? '';
      }
    } catch (err: unknown) {
      // 用类型守卫安全访问飞书 SDK 的错误属性
      const feishuErr = err as Record<string, unknown>;
      const code =
        typeof feishuErr?.code === 'number'
          ? feishuErr.code
          : ((feishuErr?.response as Record<string, unknown>)?.code as number | undefined);
      if (code !== undefined && UNREACHABLE_ERROR_CODES.includes(code)) {
        this.markUnreachable(chatId);
        throw err;
      }
      // 限流错误：不累加失败计数，不标记不可达，直接向上抛出让调用方处理
      if (code !== undefined && RATE_LIMIT_ERROR_CODES.includes(code)) {
        console.warn(`[FeishuSender] 限流错误 code=${code}，chat=${chatId}，不计入失败计数`);
        throw err;
      }
      const count = (this.failureCounts.get(chatId) ?? 0) + 1;
      this.failureCounts.set(chatId, count);
      if (count >= MAX_CONSECUTIVE_FAILURES) {
        this.markUnreachable(chatId);
      }
      throw err;
    }
  }

  // 飞书 PATCH API 仅支持 interactive 类型消息更新，text 类型不支持
  async update(messageId: string, card: FeishuCardContent): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    });
  }

  /**
   * 添加表情回应到消息
   * @param messageId 消息 ID
   * @param emojiType 表情类型（如 "HOURGLASS", "CHECK_MARK"）
   * @returns reaction_id，用于后续删除
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const resp = await this.client.im.messageReaction.create({
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
      path: {
        message_id: messageId,
      },
    });
    return resp?.data?.reaction_id ?? '';
  }

  /**
   * 删除消息的表情回应
   * @param messageId 消息 ID
   * @param reactionId 表情回应 ID
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.client.im.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });
  }

  markUnreachable(chatId: string): void {
    this.unreachableChats.add(chatId);
  }

  clearUnreachable(chatId: string): void {
    this.unreachableChats.delete(chatId);
    this.failureCounts.delete(chatId);
  }

  isUnreachable(chatId: string): boolean {
    return this.unreachableChats.has(chatId);
  }
}
