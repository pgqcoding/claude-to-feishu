// tests/unit/rate-limiter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucketLimiter } from '../../src/core/rate-limiter.js';

describe('TokenBucketLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tryAcquire', () => {
    it('allows requests within capacity', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1, name: 'test' });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('rejects when bucket is empty', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 2, refillRate: 1, name: 'test' });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('refills tokens over time', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 2, refillRate: 1, name: 'test' });
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('does not exceed max capacity on refill', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 3, refillRate: 10, name: 'test' });
      vi.advanceTimersByTime(10_000);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });
  });

  describe('waitForToken', () => {
    it('resolves immediately when token available', async () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1, name: 'test' });
      await expect(limiter.waitForToken()).resolves.toBe(true);
    });

    it('waits and resolves when token becomes available', async () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 1, name: 'test' });
      limiter.tryAcquire();
      const promise = limiter.waitForToken(2000);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(promise).resolves.toBe(true);
    });

    it('rejects on timeout', async () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 0.1, name: 'test' });
      limiter.tryAcquire();
      const promise = limiter.waitForToken(500);
      vi.advanceTimersByTime(500);
      await expect(promise).resolves.toBe(false);
    });

    it('respects abort signal', async () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 0.1, name: 'test' });
      limiter.tryAcquire();
      const controller = new AbortController();
      const promise = limiter.waitForToken(5000, controller.signal);
      controller.abort();
      await expect(promise).resolves.toBe(false);
    });

    it('等待时间接近理论值而非 100ms 的整数倍', async () => {
      // refillRate=4 token/s，空桶需等 250ms 才补充 1 个 token
      const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 4, name: 'test' });
      limiter.tryAcquire(); // 耗尽 token

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const promise = limiter.waitForToken(2000);

      // 第一个 setTimeout 是精确等待，第二个才是超时守卫
      const waitCall = setTimeoutSpy.mock.calls.find(
        ([, ms]) => typeof ms === 'number' && ms > 0 && ms < 500
      );
      // 精确等待应在 200~300ms 范围内（理论 250ms），而不是 100ms 的整数倍
      expect(waitCall).toBeDefined();
      const waitMs = waitCall![1] as number;
      expect(waitMs).toBeGreaterThan(200);
      expect(waitMs).toBeLessThanOrEqual(300);

      await vi.advanceTimersByTimeAsync(300);
      await expect(promise).resolves.toBe(true);
      setTimeoutSpy.mockRestore();
    });

    it('精确等待方案不使用 setInterval', async () => {
      // 精确 setTimeout 方案下不再使用 setInterval
      const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 4, name: 'test' });
      limiter.tryAcquire();

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const promise = limiter.waitForToken(2000);

      await vi.advanceTimersByTimeAsync(300);
      await expect(promise).resolves.toBe(true);
      // 精确等待方案不应调用 setInterval
      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });

  describe('availableTokens', () => {
    it('returns current token count', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1, name: 'test' });
      expect(limiter.availableTokens).toBe(5);
      limiter.tryAcquire();
      expect(limiter.availableTokens).toBe(4);
    });
  });
});
