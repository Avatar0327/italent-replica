/**
 * 授权补装台账的读写与租户补装锁（F-061，docs/08_设计/F-061_标准身份授权补装_方案.md §3.3）。
 * 平台通用：标准身份授权（permission/standard-profile-grants）与员工身份授权（C1-2）共用同一张只追加的
 * seed_grant_ledger。台账不参与鉴权；回补据它区分“目录新增、该补”与“租户撤销过、不该补回”。
 * 登记一律 INSERT … ON CONFLICT DO NOTHING，同一编码第一次登记的来源为准；tenant_id 取当前租户上下文（RLS 兜底）。
 */
import { eq, seedGrantLedger, type SeedLedgerSource, type Tx } from '@italent/db';
import { advisoryLock, asUuid } from '../advisory-lock.js';

export type LedgerSource = SeedLedgerSource;

/**
 * 租户级补装互斥：不同模块筛选、不同命令 ID 的回补、开通和旧的标准身份回补路由都在同一把锁上排队（DEC-361 R2-01）。
 * 锁键用 PostgreSQL 的 uuid 规范文本：平台入口接受大小写不同的同一租户 UUID，按字符串哈希会得到不同的锁。
 * 从 registry.ts 原样抽出（SQL 与锁键逐字不变），installMissingSeeds 与旧路由共用。
 */
export async function lockTenantSeeds(tx: Tx, tenantId: string): Promise<void> {
  await advisoryLock(tx, asUuid(tenantId), ':seed-install');
}

/** 当前租户在某登记项下已登记的编码与来源。 */
export async function readLedger(tx: Tx, entry: string): Promise<ReadonlyMap<string, LedgerSource>> {
  const rows = await tx
    .select({ code: seedGrantLedger.code, source: seedGrantLedger.source })
    .from(seedGrantLedger)
    .where(eq(seedGrantLedger.entry, entry));
  return new Map(rows.map((row) => [row.code, row.source]));
}

export interface LedgerRecord {
  readonly entry: string;
  readonly codes: readonly string[];
  readonly source: LedgerSource;
  /** 平台命令或租户写命令 ID；回补时 existing 里的登记没有写上下文，留空。 */
  readonly commandId: string | null;
  readonly now: Date;
}

/** 每条 INSERT 的行数上限：5 个绑定参数 × 行数要低于 PostgreSQL 的 65535 个参数。 */
const CHUNK = 2000;

/** 登记编码，返回本次**新登记**的编码（已在台账里的不改来源、不返回）。 */
export async function recordLedger(tx: Tx, record: LedgerRecord): Promise<string[]> {
  const unique = [...new Set(record.codes)];
  const recorded: string[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await tx
      .insert(seedGrantLedger)
      .values(
        unique.slice(i, i + CHUNK).map((code) => ({
          entry: record.entry,
          code,
          source: record.source,
          commandId: record.commandId,
          recordedAt: record.now,
        })),
      )
      .onConflictDoNothing()
      .returning({ code: seedGrantLedger.code });
    recorded.push(...rows.map((row) => row.code));
  }
  return recorded;
}
