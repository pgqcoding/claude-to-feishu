import { SUPPORTED_MODELS, isValidModel } from '../../types.js';
import type { ModelName } from '../../types.js';

/** 验证模型名称的结果类型 */
type ValidateResult =
  | { readonly valid: true; readonly model: ModelName }
  | { readonly valid: false; readonly error: string };

/**
 * 格式化当前模型信息，用于 /model 无参数时展示
 */
export function formatCurrentModel(model: string): string {
  return `当前模型：${model}\n\n可用模型：${SUPPORTED_MODELS.join(', ')}\n切换：/model <名称>`;
}

/**
 * 验证模型名称，有效时返回规范化的 ModelName，无效时返回错误信息
 */
export function validateModel(name: string): ValidateResult {
  const normalized = name.trim().toLowerCase();
  if (isValidModel(normalized)) {
    return { valid: true, model: normalized };
  }
  return {
    valid: false,
    error: `不支持的模型 "${name}"。可用：${SUPPORTED_MODELS.join(', ')}`,
  };
}
