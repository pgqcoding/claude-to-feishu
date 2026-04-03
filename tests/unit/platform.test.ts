import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

// ESM 下需要在顶层 mock，才能拦截模块内的 execFileSync 调用
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { normalizePath, pathsEqual, isSubPath, getConfigDir, isProcessAlive, getDiskFreeMb } from '../../src/utils/platform.js';
import { execFileSync } from 'node:child_process';

describe('platform', () => {
  describe('normalizePath', () => {
    it('resolves and lowercases on Windows', () => {
      const result = normalizePath('D:\\Work\\Project-A\\');
      expect(result).not.toMatch(/[/\\]$/);
      if (os.platform() === 'win32') {
        expect(result).toBe(result.toLowerCase());
      }
    });

    it('removes trailing slashes', () => {
      const result = normalizePath('/home/user/project/');
      expect(result).not.toMatch(/[/\\]$/);
    });
  });

  describe('pathsEqual', () => {
    it('treats paths with/without trailing slash as equal', () => {
      if (os.platform() === 'win32') {
        expect(pathsEqual('D:\\Work\\Project\\', 'D:\\Work\\Project')).toBe(true);
        expect(pathsEqual('D:\\Work\\Project', 'd:\\work\\project')).toBe(true);
      } else {
        expect(pathsEqual('/home/user/', '/home/user')).toBe(true);
      }
    });
  });

  describe('isSubPath', () => {
    it('returns true for child path', () => {
      if (os.platform() === 'win32') {
        expect(isSubPath('D:\\Work\\Project\\src', 'D:\\Work\\Project')).toBe(true);
      } else {
        expect(isSubPath('/home/user/project/src', '/home/user/project')).toBe(true);
      }
    });

    it('returns false for unrelated path', () => {
      if (os.platform() === 'win32') {
        expect(isSubPath('D:\\Other\\Project', 'D:\\Work\\Project')).toBe(false);
      } else {
        expect(isSubPath('/other/project', '/home/project')).toBe(false);
      }
    });

    it('returns false for parent traversal attempt', () => {
      if (os.platform() === 'win32') {
        expect(isSubPath('D:\\Work\\Project\\..\\Other', 'D:\\Work\\Project')).toBe(false);
      } else {
        expect(isSubPath('/home/user/../other', '/home/user')).toBe(false);
      }
    });

    it('returns true for same path', () => {
      if (os.platform() === 'win32') {
        expect(isSubPath('D:\\Work\\Project', 'D:\\Work\\Project')).toBe(true);
      } else {
        expect(isSubPath('/home/user', '/home/user')).toBe(true);
      }
    });
  });

  describe('getConfigDir', () => {
    it('returns path under home directory', () => {
      const result = getConfigDir();
      expect(result).toContain('.claude-to-feishu');
      expect(result.startsWith(os.homedir())).toBe(true);
    });
  });

  describe('isProcessAlive', () => {
    it('returns true for current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
      expect(isProcessAlive(999999)).toBe(false);
    });
  });

  describe('getDiskFreeMb (Windows 分支)', () => {
    const isWin = os.platform() === 'win32';

    it.skipIf(!isWin)('合法驱动器字母时使用 execFileSync 并返回正确 MB 数', () => {
      // 模拟 PowerShell 返回 1073741824 字节（1024 MB）
      vi.mocked(execFileSync).mockReturnValue('1073741824\n' as any);

      const result = getDiskFreeMb('C:\\some\\path');

      expect(execFileSync).toHaveBeenCalledWith(
        'powershell',
        ['-Command', '(Get-PSDrive C).Free'],
        expect.objectContaining({ encoding: 'utf8' })
      );
      expect(result).toBe(1024);

      vi.mocked(execFileSync).mockRestore();
    });

    it.skipIf(!isWin)('非法驱动器字符串时安全拒绝，不调用 execFileSync，返回 null', () => {
      // getDiskFreeMb 内部调用 path.parse(dir).root，传入根路径含注入字符的虚假路径
      // 通过传入一个 root 会被 path.parse 解析为非单字母的路径来触发校验
      // 注意：Windows 下 path.parse('\\\\server\\share') 的 root 为 '\\\\'，
      // 经过 replace('\\', '') 和 replace(':', '') 后为空字符串，不匹配 /^[A-Za-z]$/
      vi.mocked(execFileSync).mockClear();
      const result = getDiskFreeMb('\\\\server\\share\\subdir');

      expect(result).toBeNull();
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });
});
