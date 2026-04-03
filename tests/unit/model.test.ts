import { describe, it, expect } from 'vitest';
import { formatCurrentModel, validateModel } from '../../src/feishu/commands/model.js';
import { isValidModel, SUPPORTED_MODELS } from '../../src/types.js';

describe('SUPPORTED_MODELS', () => {
  it('包含 sonnet、opus、haiku', () => {
    expect(SUPPORTED_MODELS).toContain('sonnet');
    expect(SUPPORTED_MODELS).toContain('opus');
    expect(SUPPORTED_MODELS).toContain('haiku');
  });

  it('长度为 3', () => {
    expect(SUPPORTED_MODELS).toHaveLength(3);
  });
});

describe('isValidModel', () => {
  it('sonnet 为有效模型', () => {
    expect(isValidModel('sonnet')).toBe(true);
  });

  it('opus 为有效模型', () => {
    expect(isValidModel('opus')).toBe(true);
  });

  it('haiku 为有效模型', () => {
    expect(isValidModel('haiku')).toBe(true);
  });

  it('gpt-4 为无效模型', () => {
    expect(isValidModel('gpt-4')).toBe(false);
  });

  it('空字符串为无效模型', () => {
    expect(isValidModel('')).toBe(false);
  });
});

describe('formatCurrentModel', () => {
  it('包含当前模型名称', () => {
    const result = formatCurrentModel('sonnet');
    expect(result).toContain('sonnet');
    expect(result).toContain('当前模型');
  });

  it('包含所有可用模型列表', () => {
    const result = formatCurrentModel('opus');
    expect(result).toContain('sonnet');
    expect(result).toContain('opus');
    expect(result).toContain('haiku');
  });

  it('包含切换提示', () => {
    const result = formatCurrentModel('haiku');
    expect(result).toContain('/model');
  });
});

describe('validateModel', () => {
  it('有效模型名称返回 valid: true 和规范化 ModelName', () => {
    const result = validateModel('sonnet');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.model).toBe('sonnet');
    }
  });

  it('大写输入自动规范化为小写', () => {
    const result = validateModel('OPUS');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.model).toBe('opus');
    }
  });

  it('含空格的有效名称可以通过', () => {
    const result = validateModel('  haiku  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.model).toBe('haiku');
    }
  });

  it('无效模型返回 valid: false 和错误信息', () => {
    const result = validateModel('gpt-4');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('gpt-4');
      expect(result.error).toContain('sonnet');
    }
  });

  it('空字符串返回 valid: false', () => {
    const result = validateModel('');
    expect(result.valid).toBe(false);
  });
});
