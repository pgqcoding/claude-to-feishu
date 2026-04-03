import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/feishu/commands/index.js';

describe('parseCommand', () => {
  it('parses /help', () => {
    const result = parseCommand('/help');
    expect(result).toEqual({ type: 'command', name: 'help', args: '' });
  });

  it('parses /list', () => {
    const result = parseCommand('/list');
    expect(result).toEqual({ type: 'command', name: 'list', args: '' });
  });

  it('parses /switch with args', () => {
    const result = parseCommand('/switch 1');
    expect(result).toEqual({ type: 'command', name: 'switch', args: '1' });
  });

  it('parses /new with alias', () => {
    const result = parseCommand('/new project-a');
    expect(result).toEqual({ type: 'command', name: 'new', args: 'project-a' });
  });

  it('parses /stop', () => {
    const result = parseCommand('/stop');
    expect(result).toEqual({ type: 'command', name: 'stop', args: '' });
  });

  it('parses /status', () => {
    const result = parseCommand('/status');
    expect(result).toEqual({ type: 'command', name: 'status', args: '' });
  });

  it('parses /history', () => {
    const result = parseCommand('/history');
    expect(result).toEqual({ type: 'command', name: 'history', args: '' });
  });

  it('treats "/history extra" as plain message (no-args command)', () => {
    const result = parseCommand('/history extra');
    expect(result).toEqual({ type: 'message', text: '/history extra' });
  });

  it('parses /sessions without args', () => {
    const result = parseCommand('/sessions');
    expect(result).toEqual({ type: 'command', name: 'sessions', args: '' });
  });

  it('parses /sessions refresh', () => {
    const result = parseCommand('/sessions refresh');
    expect(result).toEqual({ type: 'command', name: 'sessions', args: 'refresh' });
  });

  it('treats unknown /command as command type (handler will reply "unknown command")', () => {
    // 未知命令交由 handler 统一回复提示，parseCommand 返回 type: 'command'
    const result = parseCommand('/unknown stuff');
    expect(result).toEqual({ type: 'command', name: 'unknown', args: 'stuff' });
  });

  it('treats "/list all files" as plain message (non-exact match)', () => {
    const result = parseCommand('/list all files');
    expect(result).toEqual({ type: 'message', text: '/list all files' });
  });

  it('treats plain text as message', () => {
    const result = parseCommand('帮我看看这个 bug');
    expect(result).toEqual({ type: 'message', text: '帮我看看这个 bug' });
  });

  it('trims whitespace', () => {
    const result = parseCommand('  /help  ');
    expect(result).toEqual({ type: 'command', name: 'help', args: '' });
  });

  it('parses /model without args', () => {
    const result = parseCommand('/model');
    expect(result).toEqual({ type: 'command', name: 'model', args: '' });
  });

  it('parses /model with model name', () => {
    const result = parseCommand('/model sonnet');
    expect(result).toEqual({ type: 'command', name: 'model', args: 'sonnet' });
  });

  it('parses /retry', () => {
    const result = parseCommand('/retry');
    expect(result).toEqual({ type: 'command', name: 'retry', args: '' });
  });

  it('treats "/retry extra" as plain message (no-args command)', () => {
    const result = parseCommand('/retry extra');
    expect(result).toEqual({ type: 'message', text: '/retry extra' });
  });
});
