import fs from 'node:fs';

/** 可热更新的配置字段（环境变量名） */
export const HOT_RELOADABLE_FIELDS = [
  'CTF_LOG_LEVEL',
  'CTF_MAX_CONCURRENT_QUERIES',
  'CTF_QUERY_TIMEOUT_MS',
  'CTF_DEFAULT_MODEL',
  'CTF_DEFAULT_MODE',
] as const;

/** 判断字段是否可热更新 */
export function isHotReloadable(field: string): boolean {
  return (HOT_RELOADABLE_FIELDS as readonly string[]).includes(field);
}

/** 检测两份配置之间的差异，只返回值发生变化的字段 */
export function detectChanges(
  oldConfig: Readonly<Record<string, string>>,
  newConfig: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const changes: Record<string, string> = {};
  for (const [key, value] of Object.entries(newConfig)) {
    if (oldConfig[key] !== value) {
      changes[key] = value;
    }
  }
  return changes;
}

/** 将变更分类为热更新和冷更新两组 */
export function classifyChanges(
  changes: Readonly<Record<string, string>>,
): { readonly hot: Readonly<Record<string, string>>; readonly cold: Readonly<Record<string, string>> } {
  const hot: Record<string, string> = {};
  const cold: Record<string, string> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (isHotReloadable(key)) {
      hot[key] = value;
    } else {
      cold[key] = value;
    }
  }
  return { hot, cold };
}

/** 解析 .env 文件为键值对，忽略注释和空行，自动去除引号 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 去除成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export interface ConfigWatcherOptions {
  readonly configPath: string;
  /** 有可热更新字段变化时触发，传入变更的键值对 */
  readonly onHotReload: (changes: Readonly<Record<string, string>>) => void;
  /** 有冷更新字段变化时触发，传入变更的字段名列表（需重启生效） */
  readonly onColdChange: (fields: readonly string[]) => void;
  /** 读取或解析配置文件出错时触发 */
  readonly onError: (error: Error) => void;
}

/**
 * 启动配置文件监听。
 * Windows 下 fs.watch 对同一次保存可能触发多次 change，使用 500ms debounce 去重。
 * 返回停止函数，调用后关闭监听器并清理定时器。
 */
export function startConfigWatcher(options: ConfigWatcherOptions): () => void {
  let lastConfig: Record<string, string> = {};

  // 初始加载，失败不阻塞启动
  try {
    lastConfig = parseEnvFile(options.configPath);
  } catch {
    // 首次加载失败不阻塞
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // persistent: false 避免监听器阻止进程正常退出
  const watcher = fs.watch(options.configPath, { persistent: false }, (eventType) => {
    if (eventType !== 'change') return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        const newConfig = parseEnvFile(options.configPath);
        const changes = detectChanges(lastConfig, newConfig);

        if (Object.keys(changes).length === 0) return;

        const { hot, cold } = classifyChanges(changes);

        if (Object.keys(hot).length > 0) {
          options.onHotReload(hot);
        }
        if (Object.keys(cold).length > 0) {
          options.onColdChange(Object.keys(cold));
        }

        lastConfig = newConfig;
      } catch (err) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }, 500);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
