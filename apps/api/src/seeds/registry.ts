/**
 * 种子补装登记表（DEC-361）：各模块登记自己的预置数据，新租户开通与平台回补命令走同一个 installMissingSeeds，
 * 避免两套安装逻辑。登记项只回答三件事：这个数据集有哪些预置编码（codes）、租户里已经有哪些（existing）、
 * 缺的怎么装（install）。规则由 installMissingSeeds 统一保证：
 * - 只补缺失的编码；已有编码（包括租户改名、停用、定制过的）不动，重复执行无副作用；
 * - 安装在调用方的租户事务里执行，登记项自己同事务写业务数据与审计（DEC-216，actor 为开通 / 回补命令的操作人）；
 * - 预置清单变化时登记项的 version +1，只用于回补报告，不触发覆盖。
 * 接入方式见 docs/08_设计/DEC-361_种子补装登记表.md；各模块在 seeds/index.ts 加一行 import 即可被收录。
 */
import type { Tx } from '@italent/db';

export interface SeedWriteContext {
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly now: Date;
  readonly commandId: string;
}

export interface SeedEntry {
  /** 登记模块（平台回补可按模块筛选），如 'talent-review'。 */
  readonly module: string;
  /** 数据集编码，模块内唯一，如 'preset-fields'。 */
  readonly key: string;
  readonly version: number;
  /** 该数据集的全部预置项编码（稳定、不随租户改名变化）。 */
  readonly codes: readonly string[];
  /** 当前租户里已经存在的预置项编码（含被定制 / 停用的）。 */
  readonly existing: (tx: Tx, tenantId: string) => Promise<ReadonlySet<string>>;
  /** 只构造并写入 missing 里的编码（含它们的子数据与审计）。 */
  readonly install: (tx: Tx, write: SeedWriteContext, missing: readonly string[]) => Promise<void>;
}

export interface SeedReportItem {
  readonly module: string;
  readonly key: string;
  readonly version: number;
  readonly installed: readonly string[];
  /** 预置编码里租户已有的个数（不论是否被定制）。 */
  readonly existing: number;
}

const entries: SeedEntry[] = [];

export function registerSeed(entry: SeedEntry): void {
  if (entries.some((e) => e.module === entry.module && e.key === entry.key)) {
    throw new Error(`种子 ${entry.module}/${entry.key} 已登记`);
  }
  entries.push(entry);
}

export const registeredSeeds = (): readonly SeedEntry[] => entries;
export const seedModules = (): readonly string[] => [...new Set(entries.map((e) => e.module))];

/** 逐个登记项补装缺失的预置编码，返回每个登记项的补装报告；modules 缺省 = 全部。 */
export async function installMissingSeeds(
  tx: Tx,
  write: SeedWriteContext,
  filter: { readonly modules?: readonly string[] } = {},
): Promise<SeedReportItem[]> {
  const report: SeedReportItem[] = [];
  for (const entry of entries) {
    if (filter.modules && !filter.modules.includes(entry.module)) continue;
    const have = await entry.existing(tx, write.tenantId);
    const missing = entry.codes.filter((code) => !have.has(code));
    if (missing.length > 0) await entry.install(tx, write, missing);
    report.push({
      module: entry.module,
      key: entry.key,
      version: entry.version,
      installed: missing,
      existing: entry.codes.length - missing.length,
    });
  }
  return report;
}
