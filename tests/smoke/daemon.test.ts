import { describe, it, expect } from 'vitest';

describe('daemon module exports', () => {
  it('exports createHealthServer from health module', async () => {
    const { createHealthServer } = await import('../../src/daemon/health.js');
    expect(typeof createHealthServer).toBe('function');
  });

  it('exports createMessageHandler from handler module', async () => {
    const { createMessageHandler } = await import('../../src/daemon/handler.js');
    expect(typeof createMessageHandler).toBe('function');
  }, 15000);

  it('exports PID utilities from pid module', async () => {
    const { writePidFile, removePidFile, checkExistingProcess } = await import('../../src/daemon/pid.js');
    expect(typeof writePidFile).toBe('function');
    expect(typeof removePidFile).toBe('function');
    expect(typeof checkExistingProcess).toBe('function');
  });
});
