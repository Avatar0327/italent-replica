/**
 * 按租户恢复的导入与隔离校验（DEC-061；AGENTS.md §10「恢复」「幂等」「审计」；R1-T17，PR #60 第二轮 P2-1 / 4 / 5 / 9）。
 *
 * - 导入只进隔离环境：目标库必须**完全没有租户**；备份里只能有一个租户、每一行的 tenant_id 都属于它——这些都在
 *   任何写入之前校验（P2-1）。导入、序列推进、隔离校验、平台审计与命令台账在**同一事务**提交（P2-9）。
 * - 运行身份：迁移角色（表属主），非超级用户、不带 BYPASSRLS，受 FORCE RLS 约束（命令行在启动时检查，见
 *   apps/api/src/ops/platform-cli.ts 与 docs/06_部署/01_部署运行手册.md）。行级校验不依赖这一点，超级用户下同样拒绝。
 * - 导入期间暂时卸下外键与业务触发器（版本链、只追加等护栏针对业务写入，不是原样搬回已校验的历史），导入后原样加回
 *   外键——加回即对全部已导入行重新校验引用完整性。
 * - 同一命令 ID 重试：每个阶段在隔离库的平台命令台账登记（键 = 命令 ID + 阶段），同键同内容重放首次结果，
 *   同键异内容 409；结果未知时按原命令 ID 重试即可查回（P2-9）。
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { IdempotencyConflictError, type PlatformCommandMeta, reviveEntityTimestamps } from './platform-command.js';
import { platformCommandLedger } from './schema/index.js';
import {
  BackupIntegrityError,
  type BackupRow,
  backupChecksum,
  foreignKeys,
  ident,
  migrationVersion,
  platformAuditIn,
  rowsOf,
  setTenant,
  type TenantBackup,
  tenantTables,
  textArray,
} from './tenant-backup.js';
import type { Tx } from './tenant-context.js';

const INSERT_BATCH = 500;

/** 恢复各阶段在隔离库命令台账中的键：同一命令 ID 的导入、校验、开放互不覆盖。 */
export function phaseKey(meta: PlatformCommandMeta, phase: 'import' | 'verify' | 'open'): string {
  return `${meta.commandId}:${phase}`.slice(0, 100);
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * 在调用方事务内查命令台账：同键同内容 → 首次结果；同键异内容 → IdempotencyConflictError；没有 → undefined。
 * 结果按台账原样返回（JSON），不重新执行。
 */
export async function ledgerReplay<T>(tx: Tx, key: string, request: unknown): Promise<T | undefined> {
  const [entry] = await tx.select().from(platformCommandLedger).where(eq(platformCommandLedger.commandId, key));
  if (!entry) return undefined;
  if (entry.requestHash !== hashOf(request)) throw new IdempotencyConflictError(key);
  return reviveEntityTimestamps(entry.response) as T;
}

export async function ledgerRecord(tx: Tx, key: string, request: unknown, response: unknown): Promise<void> {
  await tx.insert(platformCommandLedger).values({ commandId: key, requestHash: hashOf(request), response });
}

/** 单独开事务查台账（各阶段开工前先查，已完成的阶段直接返回）。 */
export async function findLedger<T>(db: Db, key: string, request: unknown): Promise<T | undefined> {
  return db.transaction((tx) => ledgerReplay<T>(tx, key, request));
}

/** 在途事件 / 通知的状态列：恢复不补发消息（AGENTS.md §10「恢复」），pending 一律改记 unknown，由人工核对。 */
const MESSAGE_TABLE = /(_outbox|_outbox_attempts|_delivery_attempts|_notifications)$/;

function withoutPendingMessages(table: string, rows: BackupRow[]): { rows: BackupRow[]; changed: number } {
  if (!MESSAGE_TABLE.test(table)) return { rows, changed: 0 };
  let changed = 0;
  const out = rows.map((row) => {
    for (const column of ['state', 'status'] as const) {
      if (row[column] === 'pending') {
        changed++;
        return { ...row, [column]: 'unknown' };
      }
    }
    return row;
  });
  return { rows: out, changed };
}

export async function insertRows(tx: Tx, table: string, rows: readonly BackupRow[]) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = JSON.stringify(rows.slice(i, i + INSERT_BATCH));
    await tx.execute(sql`
      INSERT INTO ${ident(table)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(table)}, ${batch}::jsonb)`);
  }
}

/**
 * 写入前的全部校验（P2-1）：格式、迁移版本（必须与目标库完全一致）、校验和、目标库没有任何租户、
 * 备份里只有这一个租户、每一行的 tenant_id 都属于它、表都存在。任何一项不过即拒绝，目标库不发生任何写入。
 */
async function assertImportable(tx: Tx, backup: TenantBackup, names: readonly string[]) {
  const { manifest } = backup;
  if (manifest.format !== 'italent-tenant-backup' || manifest.formatVersion !== 1) {
    throw new BackupIntegrityError('FORMAT_UNSUPPORTED', '不支持的备份格式');
  }
  const target = await migrationVersion(tx);
  if (target.count !== manifest.migration.count || target.lastHash !== manifest.migration.lastHash) {
    throw new BackupIntegrityError(
      'MIGRATION_VERSION_MISMATCH',
      `备份的迁移版本（${manifest.migration.count}）与目标库（${target.count}）不一致，须先把隔离环境迁移到同一版本`,
    );
  }
  if (backupChecksum(backup) !== manifest.checksum) {
    throw new BackupIntegrityError('CHECKSUM_MISMATCH', '备份内容与校验和不符');
  }
  const [occupied] = rowsOf(await tx.execute(sql`SELECT 1 FROM tenants LIMIT 1`));
  if (occupied) throw new BackupIntegrityError('TARGET_NOT_EMPTY', '恢复只导入到空的隔离环境，目标库已有租户');
  const tenantId = manifest.tenantId;
  const tenantsInBackup = backup.platform.tenants;
  if (tenantsInBackup.length !== 1 || tenantsInBackup[0]!.id !== tenantId) {
    throw new BackupIntegrityError('FOREIGN_ROW', '备份必须恰好包含清单所指的一个租户');
  }
  for (const [table, rows] of Object.entries(backup.tables)) {
    if (!names.includes(table)) throw new BackupIntegrityError('FORMAT_UNSUPPORTED', `目标库没有表 ${table}`);
    if (rows.length !== (manifest.rowCounts[table] ?? -1)) {
      throw new BackupIntegrityError('COUNT_MISMATCH', `${table} 的行数与清单不一致`);
    }
    if (rows.some((row) => row.tenant_id !== tenantId)) {
      throw new BackupIntegrityError('FOREIGN_ROW', `${table} 含有其他租户的行`);
    }
  }
}

/**
 * P2-4：显式导入 identity / serial 列后，把对应序列推进到已导入的最大值之后，恢复后新增的行排在历史之后
 * （如 employment_state_events.event_seq，同日任职排序依赖它）。逐列排查 public 下所有带序列的列。
 */
export async function advanceSequences(tx: Tx): Promise<number> {
  const columns = rowsOf<{ table: string; column: string; seq: string }>(
    await tx.execute(sql`
      SELECT c.relname AS "table", a.attname AS "column",
             pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS "seq"
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
         AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL`),
  );
  let advanced = 0;
  for (const { table, column, seq } of columns) {
    const [row] = rowsOf<{ max: string | null }>(
      await tx.execute(sql`SELECT max(${ident(column)})::text AS max FROM ${ident(table)}`),
    );
    if (row?.max === null || row?.max === undefined) continue;
    // pg_sequences.last_value 为空表示从未取号；取已导入最大值与已取号的较大者，下一个号即其后一位
    await tx.execute(sql`SELECT setval(${seq}::regclass, GREATEST(${row.max}::bigint,
      COALESCE((SELECT last_value FROM pg_sequences s
        WHERE format('%I.%I', s.schemaname, s.sequencename)::regclass = ${seq}::regclass), 0)), true)`);
    advanced++;
  }
  return advanced;
}

export interface ImportReport {
  readonly tenantId: string;
  readonly rowCounts: Record<string, number>;
  /** 恢复时由 pending 改记为 unknown 的在途事件 / 通知条数（不补发）。 */
  readonly unknownEvents: number;
  readonly isolation: IsolationReport;
}

/**
 * 把备份导入隔离环境：租户状态一律置为 restoring（除平台方外拒绝访问，DEC-061）。导入、序列推进、隔离校验、
 * 平台审计与命令台账同一事务提交，任何一步失败即整体回滚、隔离环境保持为空。
 */
export async function importTenantBackup(
  db: Db,
  backup: TenantBackup,
  meta: PlatformCommandMeta,
): Promise<ImportReport> {
  const tenantId = backup.manifest.tenantId;
  const key = phaseKey(meta, 'import');
  const request = { tenantId, checksum: backup.manifest.checksum };
  return db.transaction(async (tx) => {
    const replay = await ledgerReplay<ImportReport>(tx, key, request);
    if (replay) return replay;
    const names = await tenantTables(tx);
    await assertImportable(tx, backup, names);
    await setTenant(tx, tenantId);
    const { rowCounts, unknownEvents } = await writeRows(tx, backup, names);
    await advanceSequences(tx);
    const isolation = await isolationIn(tx, tenantId, backup, true);
    if (!isolation.ok)
      throw new BackupIntegrityError('FOREIGN_ROW', `导入后隔离校验未通过：${JSON.stringify(isolation)}`);
    const report: ImportReport = { tenantId, rowCounts, unknownEvents, isolation };
    await platformAuditIn(
      tx,
      meta,
      'tenant.restore.import',
      tenantId,
      {
        dataAsOf: backup.manifest.takenAt,
        checksum: backup.manifest.checksum,
        unknownEvents,
      },
      { actorInTarget: false },
    );
    await ledgerRecord(tx, key, request, report);
    return report;
  });
}

async function writeRows(tx: Tx, backup: TenantBackup, names: readonly string[]) {
  const fks = await foreignKeys(tx, names);
  for (const fk of fks) await tx.execute(sql`ALTER TABLE ${ident(fk.table)} DROP CONSTRAINT ${ident(fk.name)}`);
  for (const table of names) await tx.execute(sql`ALTER TABLE ${ident(table)} DISABLE TRIGGER USER`);

  const accounts = JSON.stringify(backup.platform.users);
  await tx.execute(sql`
    INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, ${accounts}::jsonb)
    ON CONFLICT (id) DO NOTHING`);
  // P2-5：隔离库的系统预置一律按备份时点的值写回（含目标库迁移带来的默认值）
  await tx.execute(sql`
    INSERT INTO system_settings SELECT * FROM jsonb_populate_recordset(NULL::system_settings,
      ${JSON.stringify(backup.platform.systemSettings)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description,
      overridable = EXCLUDED.overridable, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`);
  const restoring = backup.platform.tenants.map((t) => ({
    ...t,
    status: 'restoring',
    revision: Number(t.revision) + 1,
  }));
  await insertRows(tx, 'tenants', restoring);

  let unknownEvents = 0;
  const rowCounts: Record<string, number> = {};
  for (const table of names) {
    const { rows, changed } = withoutPendingMessages(table, backup.tables[table] ?? []);
    unknownEvents += changed;
    await insertRows(tx, table, rows);
    rowCounts[table] = rows.length;
  }

  for (const table of names) await tx.execute(sql`ALTER TABLE ${ident(table)} ENABLE TRIGGER USER`);
  // 原样加回外键：ADD CONSTRAINT 会对全部已导入行重新校验引用完整性，引用缺失即整笔回滚
  for (const fk of fks) {
    await tx.execute(sql`ALTER TABLE ${ident(fk.table)} ADD CONSTRAINT ${ident(fk.name)} ${sql.raw(fk.definition)}`);
  }
  return { rowCounts, unknownEvents };
}

export interface IsolationReport {
  readonly ok: boolean;
  /** 不属于该租户的行数（任何租户表）。 */
  readonly foreignRows: number;
  /** 隔离环境中的租户数（应为 1）。 */
  readonly tenants: number;
  /** 不在备份引用清单内的全局账号数（只在导入时比对）。 */
  readonly foreignUsers: number;
  /** 行数与备份清单不一致的表（只在导入事务内比对；对账之后行数本就会变化）。 */
  readonly countMismatches: string[];
}

class Rollback extends Error {
  constructor(readonly report: IsolationReport) {
    super('rollback');
  }
}

/**
 * 隔离校验：只有该租户的数据（无跨租户数据）。为了看见“不属于该租户”的行，在保存点内临时对表属主取消 FORCE RLS，
 * 读完回滚到保存点（不改动任何结构或数据）。compareCounts：与备份清单逐表比对行数（只在导入事务内）。
 */
export async function isolationIn(
  tx: Tx,
  tenantId: string,
  backup: TenantBackup,
  compareCounts: boolean,
): Promise<IsolationReport> {
  try {
    await tx.transaction(async (sp) => {
      const names = await tenantTables(sp);
      let foreignRows = 0;
      const countMismatches: string[] = [];
      for (const table of names) {
        await sp.execute(sql`ALTER TABLE ${ident(table)} NO FORCE ROW LEVEL SECURITY`);
        const [row] = rowsOf<{ foreign: number; own: number }>(
          await sp.execute(sql`
            SELECT count(*) FILTER (WHERE tenant_id IS DISTINCT FROM ${tenantId}::uuid)::int AS "foreign",
                   count(*) FILTER (WHERE tenant_id = ${tenantId}::uuid)::int AS "own"
              FROM ${ident(table)}`),
        );
        foreignRows += row!.foreign;
        if (compareCounts && row!.own !== (backup.manifest.rowCounts[table] ?? 0)) countMismatches.push(table);
      }
      // 账号只在导入时比对：对账会按现网补入被授权数据引用的账号（如开通时的平台运营），不属于跨租户数据
      const accounts = compareCounts ? textArray(backup.platform.users.map((x) => String(x.id))) : null;
      const foreignUsers = accounts
        ? sql`(SELECT count(*)::int FROM users u WHERE NOT (u.id::text = ANY(${accounts})))`
        : sql`0`;
      const [counts] = rowsOf<{ tenants: number; users: number }>(
        await sp.execute(sql`SELECT (SELECT count(*)::int FROM tenants) AS tenants, ${foreignUsers} AS users`),
      );
      const report: IsolationReport = {
        ok: foreignRows === 0 && counts!.tenants === 1 && counts!.users === 0 && countMismatches.length === 0,
        foreignRows,
        tenants: counts!.tenants,
        foreignUsers: counts!.users,
        countMismatches,
      };
      throw new Rollback(report);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.report;
    throw error;
  }
  throw new Error('隔离校验未产出结果');
}
