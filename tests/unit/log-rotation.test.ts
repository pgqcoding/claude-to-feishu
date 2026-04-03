import { describe, it, expect } from 'vitest';
import { shouldRotateByDate, getRotatedFileName, shouldRotate } from '../../src/utils/logger.js';

describe('日志按天轮转', () => {
  it('returns true when date has changed since last rotation', () => {
    const lastRotation = new Date('2026-03-19T23:59:59').getTime();
    const now = new Date('2026-03-20T00:00:01').getTime();
    expect(shouldRotateByDate(lastRotation, now)).toBe(true);
  });

  it('returns false when same day', () => {
    const lastRotation = new Date('2026-03-20T01:00:00').getTime();
    const now = new Date('2026-03-20T23:59:59').getTime();
    expect(shouldRotateByDate(lastRotation, now)).toBe(false);
  });

  it('generates date-based filename', () => {
    const result = getRotatedFileName('app.log', new Date('2026-03-19'));
    expect(result).toBe('app.2026-03-19.log');
  });

  it('handles filename without extension', () => {
    const result = getRotatedFileName('app', new Date('2026-03-19'));
    expect(result).toBe('app.2026-03-19');
  });
});

describe('双条件轮转', () => {
  it('rotates when size exceeds limit', () => {
    expect(shouldRotate({
      fileSizeBytes: 51 * 1024 * 1024,
      lastRotationTime: Date.now(),
      currentTime: Date.now(),
      maxSizeBytes: 50 * 1024 * 1024,
    })).toBe(true);
  });

  it('rotates when date has changed', () => {
    const yesterday = new Date('2026-03-19T12:00:00').getTime();
    const today = new Date('2026-03-20T00:01:00').getTime();
    expect(shouldRotate({
      fileSizeBytes: 1024,
      lastRotationTime: yesterday,
      currentTime: today,
      maxSizeBytes: 50 * 1024 * 1024,
    })).toBe(true);
  });

  it('does not rotate when neither condition met', () => {
    const now = Date.now();
    expect(shouldRotate({
      fileSizeBytes: 1024,
      lastRotationTime: now - 1000,
      currentTime: now,
      maxSizeBytes: 50 * 1024 * 1024,
    })).toBe(false);
  });
});
