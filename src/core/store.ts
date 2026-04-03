import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../types.js';
import { CURRENT_STORE_VERSION } from './migration.js';

const EMPTY_STATE: AppState = {
  version: 1,
  currentBinding: null,
  recentSessionIds: [],
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Store {
  private readonly filePath: string;
  private inMemoryState: AppState | null = null;
  /** 写入锁：Promise 链串行化并发 save，防止竞态写入损坏文件 */
  private saveQueue: Promise<boolean> = Promise.resolve(true);

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<AppState> {
    // 内存缓存命中时直接返回，跳过文件系统读取（冷启动后的热路径）
    if (this.inMemoryState !== null) {
      return this.inMemoryState;
    }

    // 冷启动：检查 .tmp 文件恢复
    const tmpPath = this.filePath + '.tmp';
    if (fs.existsSync(tmpPath)) {
      try {
        const tmpStat = fs.statSync(tmpPath);
        const mainExists = fs.existsSync(this.filePath);
        const mainStat = mainExists ? fs.statSync(this.filePath) : null;
        if (mainStat === null || tmpStat.mtimeMs > mainStat.mtimeMs) {
          fs.renameSync(tmpPath, this.filePath);
        } else {
          fs.unlinkSync(tmpPath);
        }
      } catch (err) {
        // tmp 恢复失败不影响主流程，但记录 warn 便于排查
        console.warn('[Store] tmp 文件恢复失败，已跳过:', err);
      }
    }

    if (!fs.existsSync(this.filePath)) {
      this.inMemoryState = { ...EMPTY_STATE };
      return this.inMemoryState;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as AppState;

      // 降级保护：文件版本高于当前代码支持的最高版本，可能是从高版本降级
      // 读取高版本字段可能引发兼容性问题，安全起见返回默认状态
      if (typeof parsed.version === 'number' && parsed.version > CURRENT_STORE_VERSION) {
        console.warn(
          `[Store] 文件版本 (${parsed.version}) 高于当前应用版本 (${CURRENT_STORE_VERSION})，` +
          `疑似从高版本降级，已忽略状态文件并使用默认状态。`
        );
        this.inMemoryState = { ...EMPTY_STATE };
        return this.inMemoryState;
      }

      this.inMemoryState = { ...parsed };
      return this.inMemoryState;
    } catch {
      // JSON 损坏，备份后返回空状态
      const backupName = path.basename(this.filePath) + '.corrupted.' + Date.now();
      const backupPath = path.join(path.dirname(this.filePath), backupName);
      try {
        fs.renameSync(this.filePath, backupPath);
      } catch {
        // 备份也失败则忽略
      }
      this.inMemoryState = { ...EMPTY_STATE };
      return this.inMemoryState;
    }
  }

  async save(state: AppState): Promise<boolean> {
    // 通过 Promise 链串行化写入，防止并发 save 竞态
    // 注意：inMemoryState 在 doSave 成功后才更新，确保其代表最后一次成功持久化的状态
    const result = this.saveQueue.then(() => this.doSave(state));
    this.saveQueue = result.then(() => true, () => true);
    return result;
  }

  private async doSave(state: AppState): Promise<boolean> {
    const tmpPath = this.filePath + '.tmp';
    const content = JSON.stringify(state, null, 2);

    // 确保目录存在
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, this.filePath);
        // 持久化成功后才更新内存缓存，保证 getInMemoryState() 代表最后成功写入的状态
        this.inMemoryState = state;
        return true;
      } catch {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    return false;
  }

  /** 获取内存中的状态（写入失败时降级使用） */
  getInMemoryState(): AppState {
    return this.inMemoryState ?? EMPTY_STATE;
  }
}
