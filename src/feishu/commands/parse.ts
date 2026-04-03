import type { CommandResult } from '../../types.js';

/**
 * 已注册命令定义
 * hasArgs: true 表示命令接受参数（如 /switch 1）
 * hasArgs: false 表示命令不接受参数，后面有内容则视为普通消息
 */
export const COMMANDS: ReadonlyMap<string, { hasArgs: boolean }> = new Map([
  ['help', { hasArgs: false }],
  ['list', { hasArgs: false }],
  ['switch', { hasArgs: true }],
  ['new', { hasArgs: true }],
  ['stop', { hasArgs: false }],
  ['status', { hasArgs: false }],
  ['history', { hasArgs: false }],
  ['sessions', { hasArgs: true }],
  ['model', { hasArgs: true }],
  ['retry', { hasArgs: false }],
  ['resume', { hasArgs: true }],
  ['fork', { hasArgs: false }],
  ['approve', { hasArgs: false }],
]);

/**
 * 解析用户消息为命令或普通文本
 * 策略：精确匹配已注册命令前缀，无参命令后面有内容则视为普通文本
 */
export function parseCommand(text: string): CommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'message', text: trimmed };
  }

  const spaceIndex = trimmed.indexOf(' ', 1);
  let name: string;
  let rest: string;

  if (spaceIndex === -1) {
    name = trimmed.slice(1).toLowerCase();
    rest = '';
  } else {
    name = trimmed.slice(1, spaceIndex).toLowerCase();
    rest = trimmed.slice(spaceIndex + 1).trim();
  }

  const cmd = COMMANDS.get(name);
  if (!cmd) {
    // 未注册的命令（如 /foo）：交给 handler 统一回复"未知命令"提示
    return { type: 'command', name, args: rest };
  }

  // 无参命令但有额外内容 → 普通文本
  if (!cmd.hasArgs && rest.length > 0) {
    return { type: 'message', text: trimmed };
  }

  return { type: 'command', name, args: rest };
}
