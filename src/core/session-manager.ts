import type { SessionInfo, SessionBinding, AppState } from '../types.js';
import type { Store } from './store.js';
import type { SdkBridge } from './sdk-bridge.js';
import { isSubPath } from '../utils/platform.js';

interface SessionManagerConfig {
  readonly store: Store;
  readonly bridge: Pick<SdkBridge, 'listProjectSessions'>;
  readonly allowedDirs: readonly string[];
  readonly dirAliases: ReadonlyMap<string, string>;
}

/** 缓存 TTL：30 秒内复用上次列表结果，避免频繁扫描目录 */
const CACHE_TTL_MS = 30_000;

export class SessionManager {
  private readonly store: Store;
  private readonly bridge: Pick<SdkBridge, 'listProjectSessions'>;
  private readonly allowedDirs: readonly string[];
  private readonly dirAliases: ReadonlyMap<string, string>;
  private cachedSessions: readonly SessionInfo[] = [];
  /** 上次成功刷新缓存的时间戳（ms），0 表示从未刷新 */
  private cacheUpdatedAt = 0;

  constructor(config: SessionManagerConfig) {
    this.store = config.store;
    this.bridge = config.bridge;
    this.allowedDirs = config.allowedDirs;
    this.dirAliases = config.dirAliases;
  }

  /** 列出所有白名单目录的会话，按最近活跃排序；TTL 内直接返回缓存 */
  async listSessions(forceRefresh = false): Promise<readonly SessionInfo[]> {
    const now = Date.now();
    // TTL 内且不强制刷新，直接返回缓存
    if (!forceRefresh && this.cacheUpdatedAt > 0 && now - this.cacheUpdatedAt < CACHE_TTL_MS) {
      return this.cachedSessions;
    }

    // 并行查询所有白名单目录，单个目录失败不影响其他
    const results = await Promise.allSettled(
      this.allowedDirs.map(dir => this.bridge.listProjectSessions(dir))
    );

    const allSessions: SessionInfo[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allSessions.push(...result.value);
      }
      // rejected 的目录静默跳过；如需排查可在此处记录 warn：
      // else { console.warn('listSessions: 目录查询失败', result.reason); }
    }

    const sorted = [...allSessions].sort((a, b) => b.lastModified - a.lastModified);
    this.cachedSessions = sorted;
    this.cacheUpdatedAt = Date.now();
    return sorted;
  }

  /** 切换会话（支持序号或 sessionId），projectDir 从目标会话的 cwd 自动推断 */
  async switchSession(indexOrId: string): Promise<SessionBinding> {
    let targetSession: SessionInfo | undefined;

    // 尝试按序号解析（1-based）
    const index = parseInt(indexOrId, 10);
    if (!isNaN(index) && index >= 1 && index <= this.cachedSessions.length) {
      targetSession = this.cachedSessions[index - 1];
    }

    // 尝试按 sessionId 匹配
    if (!targetSession) {
      targetSession = this.cachedSessions.find(s => s.sessionId === indexOrId);
    }

    if (!targetSession) {
      throw new Error(`未找到会话：${indexOrId}。请先用 /list 查看可用会话`);
    }

    const projectDir = targetSession.cwd;

    // 校验 cwd 必须在白名单目录内，防止路径遍历攻击
    const isAllowed = this.allowedDirs.some(allowed => isSubPath(projectDir, allowed));
    if (!isAllowed) {
      throw new Error(`会话目录 "${projectDir}" 不在允许的目录列表中，拒绝切换`);
    }

    const alias = this.findAlias(projectDir) ?? projectDir;

    const binding: SessionBinding = {
      sessionId: targetSession.sessionId,
      projectDir,
      projectAlias: alias,
      boundAt: Date.now(),
    };

    const state = await this.store.load();
    const newState: AppState = {
      ...state,
      currentBinding: binding,
      recentSessionIds: [
        targetSession.sessionId,
        ...state.recentSessionIds.filter(id => id !== targetSession!.sessionId),
      ].slice(0, 20),
    };
    await this.store.save(newState);

    return binding;
  }

  /** 获取当前绑定 */
  async getCurrentBinding(): Promise<SessionBinding | null> {
    const state = await this.store.load();
    return state.currentBinding;
  }

  /** 清除当前绑定 */
  async clearBinding(): Promise<void> {
    const state = await this.store.load();
    await this.store.save({ ...state, currentBinding: null });
  }

  /** 解析别名到目录路径 */
  resolveAlias(alias: string): string | null {
    return this.dirAliases.get(alias) ?? null;
  }

  /** 列出可用的项目目录（用于 /new 无参数时） */
  getAvailableDirs(): Array<{ alias: string; dir: string }> {
    const result: Array<{ alias: string; dir: string }> = [];
    for (const [alias, dir] of this.dirAliases) {
      result.push({ alias, dir });
    }
    for (const dir of this.allowedDirs) {
      if (!result.find(r => r.dir === dir)) {
        result.push({ alias: dir, dir });
      }
    }
    return result;
  }

  private findAlias(dir: string): string | null {
    for (const [alias, aliasDir] of this.dirAliases) {
      if (aliasDir === dir) return alias;
    }
    return null;
  }
}
