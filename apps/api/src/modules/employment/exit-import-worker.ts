import type { Db } from '@italent/db';

/** 桩：测试提交先固定导出签名，执行器在下一个提交实现（F-493 S3a，设计 §4.2）。 */
export interface ExitImportTestHooks {
  readonly beforeBatch?: () => Promise<void>;
  readonly beforeRow?: (rowNo: number) => Promise<void>;
  readonly failRow?: (rowNo: number) => Error | undefined;
}

export function installExitImportTestHooks(_db: Db, _hooks: ExitImportTestHooks): void {}
export async function drainExitImports(_db: Db, _tenantId: string): Promise<void> {}
export function wakeExitImports(_db: Db, _tenantId: string): void {}
export async function exitImportIdle(_db: Db): Promise<void> {}
