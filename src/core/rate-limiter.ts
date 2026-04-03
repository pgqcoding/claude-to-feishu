// src/core/rate-limiter.ts
import type { RateLimiterConfig } from '../types.js';

/**
 * Token Bucket 速率限制器
 * 用于飞书 API 调用限流（发送 ≤40 QPS、更新 ≤4 QPS）
 */
export class TokenBucketLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens/秒
  private readonly name: string;
  private lastRefillTime: number;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.name = config.name;
    this.tokens = config.maxTokens;
    this.lastRefillTime = Date.now();
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  waitForToken(timeoutMs: number = 5000, signal?: AbortSignal): Promise<boolean> {
    if (this.tryAcquire()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let waitId: ReturnType<typeof setTimeout> | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (waitId !== undefined) clearTimeout(waitId);
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        resolve(false);
      };

      if (signal?.aborted) {
        resolve(false);
        return;
      }
      signal?.addEventListener('abort', onAbort);

      // 计算下次 token 可用的精确等待时间，避免 100ms 固定轮询造成浪费
      const scheduleNext = () => {
        this.refill();
        if (this.tokens >= 1) {
          // refill 后已有 token，直接尝试获取
          if (this.tryAcquire()) {
            cleanup();
            resolve(true);
            return;
          }
        }
        // 距离补充 1 个 token 还需要多少毫秒
        const msUntilToken = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
        waitId = setTimeout(() => {
          if (this.tryAcquire()) {
            cleanup();
            resolve(true);
          } else {
            // 浮点误差导致 token 仍不足，短暂回退重试一次（5ms + 随机抖动 0-10ms，避免惊群）
            const jitter = Math.floor(Math.random() * 10);
            waitId = setTimeout(() => {
              if (this.tryAcquire()) {
                cleanup();
                resolve(true);
              } else {
                // 回退仍失败，继续等下一个周期
                scheduleNext();
              }
            }, 5 + jitter);
          }
        }, msUntilToken);
      };

      scheduleNext();

      timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }
}

export interface FeishuRateLimiters {
  readonly messageSend: TokenBucketLimiter;
  readonly messageUpdate: TokenBucketLimiter;
}

/**
 * 入站消息速率限制器
 * 为每个 openId 独立维护一个令牌桶，限制用户发送消息的频率。
 * 配置为每分钟 N 条消息，通过 refillRate = N/60 (token/s) 实现。
 */
export class InboundRateLimiter {
  /** 每个 openId 对应的令牌桶 */
  private readonly buckets = new Map<string, TokenBucketLimiter>();
  /** 每用户每分钟最大消息数 */
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  /**
   * 尝试为指定用户获取令牌
   * @returns true 表示放行，false 表示超限
   */
  tryAcquire(openId: string): boolean {
    // 0 表示不限流，直接放行
    if (this.maxPerMinute === 0) return true;

    const bucket = this.getOrCreateBucket(openId);
    return bucket.tryAcquire();
  }

  /** 获取指定用户当前剩余可用令牌数 */
  availableTokens(openId: string): number {
    if (this.maxPerMinute === 0) return Infinity;
    return this.getOrCreateBucket(openId).availableTokens;
  }

  private getOrCreateBucket(openId: string): TokenBucketLimiter {
    let bucket = this.buckets.get(openId);
    if (!bucket) {
      bucket = new TokenBucketLimiter({
        // 桶容量 = 每分钟上限，允许短时间内用完所有额度（burst）
        maxTokens: this.maxPerMinute,
        // 补充速率 = N/60 token/s，即每分钟补充 N 个
        refillRate: this.maxPerMinute / 60,
        name: `inbound-${openId}`,
      });
      this.buckets.set(openId, bucket);
    }
    return bucket;
  }
}

export function createFeishuRateLimiters(): FeishuRateLimiters {
  return {
    messageSend: new TokenBucketLimiter({
      maxTokens: 40,
      refillRate: 40,
      name: 'feishu-message-send',
    }),
    messageUpdate: new TokenBucketLimiter({
      maxTokens: 4,
      refillRate: 4,
      name: 'feishu-message-update',
    }),
  };
}
