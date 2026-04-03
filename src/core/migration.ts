import fs from 'node:fs';

/** 迁移步骤 */
export interface MigrationStep {
  readonly from: number;
  readonly to: number;
}

/** 迁移函数类型 */
export type MigrationFn = (state: Record<string, unknown>) => Record<string, unknown>;

/** 检测是否需要迁移 */
export function needsMigration(storeVersion: number, appVersion: number): boolean {
  if (storeVersion > appVersion) {
    throw new Error(`数据版本 (${storeVersion}) 高于应用版本 (${appVersion})，不支持降级`);
  }
  return storeVersion < appVersion;
}

/** 生成有序的迁移路径 */
export function getMigrationPath(fromVersion: number, toVersion: number): readonly MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (let v = fromVersion; v < toVersion; v++) {
    steps.push({ from: v, to: v + 1 });
  }
  return steps;
}

/** 创建数据目录备份 */
export async function createBackup(dataDir: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${dataDir}.backup-${timestamp}`;
  await fs.promises.cp(dataDir, backupDir, { recursive: true });
  return backupDir;
}

/** 按顺序执行迁移脚本 */
export async function executeMigration(
  state: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: ReadonlyMap<number, MigrationFn>,
): Promise<Record<string, unknown>> {
  const steps = getMigrationPath(fromVersion, toVersion);
  let current = { ...state };

  for (const step of steps) {
    const migrateFn = migrations.get(step.to);
    if (!migrateFn) {
      throw new Error(`缺少迁移脚本: v${step.from} → v${step.to}`);
    }
    current = migrateFn(current);
  }

  return current;
}

/** 当前应用数据版本 */
export const CURRENT_STORE_VERSION = 1;

/** 已注册的迁移脚本（目标版本号 → 迁移函数） */
export const STORE_MIGRATIONS: ReadonlyMap<number, MigrationFn> = new Map([
  // 未来版本升级时在此添加
  // [2, (state) => ({ ...state, version: 2, newField: 'default' })],
]);
