/**
 * 授权补装台账的读写与租户补装锁（F-061，docs/08_设计/F-061_标准身份授权补装_方案.md §3.3）。
 * 平台通用：标准身份授权（permission/standard-profile-grants）与员工身份授权（C1-2）共用同一张只追加的
 * seed_grant_ledger。台账不参与鉴权；回补据它区分“目录新增、该补”与“租户撤销过、不该补回”。
 * 登记一律 INSERT … ON CONFLICT DO NOTHING，同一编码第一次登记的来源为准；tenant_id 取当前租户上下文（RLS 兜底）。
 */
import { eq, seedGrantLedger, type SeedLedgerSource, type Tx } from '@italent/db';
import { objectGrantItems, objectModifiedMarker, type ObjectPermission } from '@italent/domain';
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

/**
 * 受管授权登记（方案 §4.4）：平台会回补授权的登记项在这里登记“自己管哪些身份 × 对象”。租户保存对象权限的唯一入口
 * setObjectPermission 在身份行锁之后、同一事务里调 recordTenantSave，命中的每个登记项各自以自己的 entry 记账。
 * 手工身份（source = custom）和没有登记的身份不写任何行。C1-2 为员工身份登记自己的授权项也走这里。
 */
export interface ManagedGrants {
  readonly entry: string;
  readonly profileCode: string;
  readonly profileSource: 'standard' | 'custom';
  /** 该对象下本登记项管的授权项编码（身份定义授予的项）。 */
  readonly codesFor: (objectCode: string) => readonly string[];
}

const managed: ManagedGrants[] = [];

export function registerManagedGrants(grants: ManagedGrants): void {
  const duplicate = managed.some(
    (m) => m.entry === grants.entry && m.profileCode === grants.profileCode && m.profileSource === grants.profileSource,
  );
  if (duplicate) throw new Error(`受管授权 ${grants.entry} × ${grants.profileCode}（${grants.profileSource}）已登记`);
  managed.push(grants);
}

export interface TenantSaveWrite {
  readonly now: Date;
  readonly commandId: string;
}

/**
 * 租户保存了某身份某对象的权限：每个命中的登记项以 tenant_saved 登记 ① <身份>/<对象>/@modified 标记；
 * ② 该登记项管的编码中保存前或保存后为已授予的项（保证“租户授过、后来撤销”的项无论回补是否跑过都不会被补回）。
 * verifiedCatalogDigest：请求携带且已与服务端当前一致的对象目录指纹；D2 = A（PR-3）起据此再登记面板上可见但未勾的项，
 * 没带指纹的旧客户端只做 ①②。
 */
export async function recordTenantSave(
  tx: Tx,
  write: TenantSaveWrite,
  profile: { readonly code: string; readonly source: 'standard' | 'custom' },
  objectCode: string,
  before: ObjectPermission | null | undefined,
  after: ObjectPermission,
  _verifiedCatalogDigest?: string,
): Promise<void> {
  const hits = managed.filter((m) => m.profileCode === profile.code && m.profileSource === profile.source);
  if (hits.length === 0) return;
  const granted = new Set(
    [...(before ? objectGrantItems(profile.code, before) : []), ...objectGrantItems(profile.code, after)].map(
      (item) => item.code,
    ),
  );
  for (const hit of hits) {
    const own = new Set(hit.codesFor(objectCode));
    await recordLedger(tx, {
      entry: hit.entry,
      codes: [objectModifiedMarker(profile.code, objectCode), ...[...granted].filter((code) => own.has(code))],
      source: 'tenant_saved',
      commandId: write.commandId,
      now: write.now,
    });
  }
}
