/**
 * 种子补装登记表（DEC-361）：各模块登记自己的预置数据，新租户开通与平台回补命令走同一个 installMissingSeeds，
 * 避免两套安装逻辑。登记项只回答三件事：这个数据集有哪些预置编码（codes）、租户里已经有哪些（existing）、
 * 缺的怎么装（install）。规则由 installMissingSeeds 统一保证：
 * - 只补缺失的编码；已有编码（包括租户改名、停用、定制过的）不动，重复执行无副作用；
 * - 安装在调用方的租户事务里执行，登记项自己同事务写业务数据与审计（DEC-216，actor 为开通 / 回补命令的操作人）；
 * - 预置清单变化时登记项的 version +1，只用于回补报告，不触发覆盖；
 * - 读取已有编码之前先取租户级事务锁（开通与回补共用）：并发的回补 / 开通排队，后到者等前者提交后读到“已存在”，
 *   不会两边都读到缺失再撞唯一约束（DEC-361 R2-01）。
 * 接入方式见 docs/08_设计/DEC-361_种子补装登记表.md；各模块在 seeds/index.ts 加一行 import 即可被收录。
 */
import { sql, type Tx } from '@italent/db';

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
  /**
   * 只构造并写入 missing 里的编码（含它们的子数据与审计）。依赖的租户数据不可用（如被停用 / 改了属性的字段）时，
   * 不装该编码并在返回值的 skipped 里给出受控原因，不报错、不覆盖租户定制；其余编码照常安装。
   */
  readonly install: (tx: Tx, write: SeedWriteContext, missing: readonly string[]) => Promise<SeedInstallResult | void>;
}

export interface SeedSkip {
  readonly code: string;
  readonly reason: string;
}
export interface SeedInstallResult {
  readonly skipped?: readonly SeedSkip[];
}

export interface SeedReportItem {
  readonly module: string;
  readonly key: string;
  readonly version: number;
  readonly installed: readonly string[];
  /** 预置编码里租户已有的个数（不论是否被定制）。 */
  readonly existing: number;
  /** 依赖不可用而没有安装的编码与原因（没有时不出现）。 */
  readonly skipped?: readonly SeedSkip[];
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
  // 租户级互斥：不同模块筛选、不同命令 ID 的回补与开通都在同一把锁上排队。锁键用 PostgreSQL 的 uuid 规范文本：
  // 平台入口接受大小写不同的同一租户 UUID，按字符串哈希会得到不同的锁（DEC-361 R2-01 残项）
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended((${write.tenantId}::uuid)::text || ':seed-install', 0))`,
  );
  const report: SeedReportItem[] = [];
  for (const entry of entries) {
    if (filter.modules && !filter.modules.includes(entry.module)) continue;
    const have = await entry.existing(tx, write.tenantId);
    const missing = entry.codes.filter((code) => !have.has(code));
    const result = missing.length > 0 ? await entry.install(tx, write, missing) : undefined;
    const skipped = result?.skipped ?? [];
    const skippedCodes = new Set(skipped.map((item) => item.code));
    report.push({
      module: entry.module,
      key: entry.key,
      version: entry.version,
      installed: missing.filter((code) => !skippedCodes.has(code)),
      existing: entry.codes.length - missing.length,
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  }
  return report;
}
