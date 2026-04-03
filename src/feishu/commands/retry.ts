/** 上次查询记录（per chatId） */
export interface LastQuery {
  readonly prompt: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly projectDir: string;
  readonly success: boolean;
  readonly timestamp: number;
}

/**
 * 管理每个 chatId 的最后一次查询记录
 * 纯内存存储，不持久化（重启后清空合理）
 */
export class RetryStore {
  private readonly queries = new Map<string, LastQuery>();

  /** 记录一次查询，成功时清除旧记录（仅保留失败记录以供重试） */
  record(query: LastQuery): void {
    if (query.success) {
      this.queries.delete(query.chatId);
    } else {
      this.queries.set(query.chatId, query);
    }
  }

  /** 获取可重试的查询（仅返回失败的） */
  getRetryable(chatId: string): LastQuery | null {
    const last = this.queries.get(chatId) ?? null;
    if (last && !last.success) return last;
    return null;
  }

  /** 清除记录 */
  clear(chatId: string): void {
    this.queries.delete(chatId);
  }
}
