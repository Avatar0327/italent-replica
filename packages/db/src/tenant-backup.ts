/**
 * 按租户的逻辑备份与恢复导入（DEC-061；AGENTS.md §10「恢复」；R1-T17）。恢复单元 =
 * 租户数据的一致快照（REPEATABLE READ 只读事务）+ 附件清单与哈希 + 代码 / 迁移版本，整体带校验和。
 *
 * 运行身份：与 db:migrate 相同的迁移角色（表属主）。读写一律先设 app.tenant_id——FORCE RLS 对表属主同样生效，
 * 租户隔离由数据库保证；每张表另带 tenant_id 条件，超级用户（绕过 RLS）下结果也不变。
 * 恢复只导入到隔离环境（新建并迁移到同一版本的空库）：导入期间暂时卸下外键与业务触发器（版本链、只追加等护栏
 * 针对的是业务写入，不是原样搬回已校验过的历史），导入完成后原样加回外键——加回即对全部行重新校验引用完整性。
 * 业务层的授权对账与开放访问见 apps/api/src/modules/platform/restore.ts。
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import type { PlatformCommandMeta } from './platform-command.js';
import { platformAuditEvents } from './schema/index.js';
import { isUuid, type Tx, withPlatform } from './tenant-context.js';

export type BackupRow = Record<string, unknown>;

export interface BackupAttachment {
  readonly id: string;
  readonly employeeId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly status: string;
}

export interface MigrationVersion {
  /** 已执行的迁移条数。 */
  count: number;
  /** 最后一条迁移的哈希（drizzle 迁移台账）。 */
  lastHash: string;
}

export interface BackupManifest {
  readonly format: 'italent-tenant-backup';
  readonly formatVersion: 1;
  readonly tenantId: string;
  /** 快照时点（数据库事务时间，UTC）。恢复出的数据即这一时点的状态（RPO 由备份频率决定）。 */
  readonly takenAt: string;
  /** 产出备份的代码版本（部署时注入，如镜像标签 / 提交号）。 */
  readonly codeVersion: string;
  migration: MigrationVersion;
  readonly rowCounts: Record<string, number>;
  readonly attachments: BackupAttachment[];
  /** tables、platform 与清单其余部分的 SHA-256（键排序后的 JSON）。 */
  checksum: string;
}

export interface TenantBackup {
  manifest: BackupManifest;
  /** 平台级表中该租户引用到的行：租户本身、引用到的全局账号、引用到的系统预置。 */
  platform: { tenants: BackupRow[]; users: BackupRow[]; systemSettings: BackupRow[] };
  /** 每张带 tenant_id 的表中该租户的全部行（列名即数据库列名）。 */
  tables: Record<string, BackupRow[]>;
}

export type BackupIntegrityReason =
  | 'TENANT_NOT_FOUND'
  | 'FORMAT_UNSUPPORTED'
  | 'CHECKSUM_MISMATCH'
  | 'MIGRATION_VERSION_MISMATCH'
  | 'TENANT_EXISTS'
  | 'FOREIGN_ROW'
  | 'DECRYPT_FAILED'
  | 'RESTORE_NOT_VERIFIED';

/** 备份 / 恢复的完整性问题：一律拒绝继续，原因机器可读。 */
export class BackupIntegrityError extends Error {
  constructor(
    readonly reason: BackupIntegrityReason,
    message: string,
  ) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

const PAGE = 1000;
const INSERT_BATCH = 500;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

const ident = (name: string) => sql.identifier(name);
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/** public 中带 tenant_id 列的全部表（与 guard-rls 的口径一致），按名称排序。 */
export async function tenantTables(tx: Tx): Promise<string[]> {
  const rows = rowsOf<{ name: string }>(
    await tx.execute(sql`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND NOT a.attisdropped)
       ORDER BY c.relname`),
  );
  return rows.map((r) => r.name);
}

/** 目标库已执行到的迁移版本（drizzle 迁移台账）。 */
export async function migrationVersion(tx: Tx): Promise<MigrationVersion> {
  const [row] = rowsOf<{ count: number; last_hash: string | null }>(
    await tx.execute(sql`
      SELECT count(*)::int AS count,
             (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1) AS last_hash
        FROM drizzle.__drizzle_migrations`),
  );
  return { count: row?.count ?? 0, lastHash: row?.last_hash ?? '' };
}

async function setTenant(tx: Tx, tenantId: string) {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
}

/** 按 ctid 分页读出一张表中该租户的全部行（同一快照内 ctid 稳定），不一次读入整表。 */
async function readTable(tx: Tx, table: string, tenantId: string): Promise<BackupRow[]> {
  const out: BackupRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { r: BackupRow; t: string }[] = rowsOf<{ r: BackupRow; t: string }>(
      await tx.execute(sql`
        SELECT to_jsonb(x) AS r, x.ctid::text AS t FROM ${ident(table)} x
         WHERE x.tenant_id = ${tenantId}::uuid ${after ? sql`AND x.ctid > ${after}::tid` : sql``}
         ORDER BY x.ctid LIMIT ${PAGE}`),
    );
    for (const { r } of page) {
      if (r.tenant_id !== tenantId) throw new BackupIntegrityError('FOREIGN_ROW', `${table} 读到了其他租户的行`);
      out.push(r);
    }
    if (page.length < PAGE) return out;
    after = page.at(-1)!.t;
  }
}

interface ForeignKey {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
  readonly target: string;
  readonly columns: string[];
}

/** 指定子表上的外键定义（恢复时卸下再原样加回；导出时用于找出引用到的平台级行）。 */
async function foreignKeys(tx: Tx, tables: readonly string[]): Promise<ForeignKey[]> {
  if (tables.length === 0) return [];
  return rowsOf<ForeignKey>(
    await tx.execute(sql`
      SELECT c.relname AS "table", k.conname AS "name", pg_get_constraintdef(k.oid) AS "definition",
             p.relname AS "target",
             ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
                     JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i) AS "columns"
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE k.contype = 'f' AND n.nspname = 'public'
         AND c.relname = ANY(${textArray(tables)})
       ORDER BY c.relname, k.conname`),
  );
}

/** 子表行中引用到某平台级表（单列外键）的值。 */
function referencedValues(tables: Record<string, BackupRow[]>, fks: readonly ForeignKey[], target: string) {
  const values = new Set<string>();
  for (const fk of fks.filter((f) => f.target === target && f.columns.length === 1)) {
    for (const row of tables[fk.table] ?? []) {
      const value = row[fk.columns[0]!];
      if (typeof value === 'string') values.add(value);
    }
  }
  return [...values].sort();
}

async function platformRows(tx: Tx, table: 'users' | 'system_settings', column: string, values: string[]) {
  if (values.length === 0) return [];
  return rowsOf<{ r: BackupRow }>(
    await tx.execute(sql`
      SELECT to_jsonb(x) AS r FROM ${ident(table)} x
       WHERE x.${ident(column)}::text = ANY(${textArray(values)})
       ORDER BY x.${ident(column)}`),
  ).map((x) => x.r);
}

/** 键排序后的 JSON：校验和不受对象键顺序影响。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function backupChecksum(backup: TenantBackup): string {
  const { checksum: _checksum, ...manifest } = backup.manifest;
  return createHash('sha256')
    .update(canonical({ manifest, platform: backup.platform, tables: backup.tables }))
    .digest('hex');
}

export interface BackupOptions {
  readonly tenantId: string;
  readonly codeVersion: string;
}

/**
 * 导出某租户的一致快照（只读 REPEATABLE READ 事务，所有表同一快照），并在平台审计记一笔导出。
 * 导出内容只含该租户的行与它引用到的平台级行，读到任何他租户行即中止（FOREIGN_ROW）。
 */
export async function exportTenantBackup(db: Db, options: BackupOptions, meta: PlatformCommandMeta) {
  const { tenantId } = options;
  if (!isUuid(tenantId)) throw new BackupIntegrityError('TENANT_NOT_FOUND', '租户 ID 不合法');
  const backup = await db.transaction(
    async (tx) => {
      await setTenant(tx, tenantId);
      const [taken] = rowsOf<{ at: string }>(
        await tx.execute(sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`),
      );
      const [tenant] = rowsOf<{ r: BackupRow }>(
        await tx.execute(sql`SELECT to_jsonb(t) AS r FROM tenants t WHERE t.id = ${tenantId}::uuid`),
      );
      if (!tenant) throw new BackupIntegrityError('TENANT_NOT_FOUND', '租户不存在');
      const names = await tenantTables(tx);
      const tables: Record<string, BackupRow[]> = {};
      for (const name of names) tables[name] = await readTable(tx, name, tenantId);
      const fks = await foreignKeys(tx, names);
      const platform = {
        tenants: [tenant.r],
        users: await platformRows(tx, 'users', 'id', referencedValues(tables, fks, 'users')),
        systemSettings: await platformRows(
          tx,
          'system_settings',
          'key',
          referencedValues(tables, fks, 'system_settings'),
        ),
      };
      const manifest: BackupManifest = {
        format: 'italent-tenant-backup',
        formatVersion: 1,
        tenantId,
        takenAt: taken!.at,
        codeVersion: options.codeVersion,
        migration: await migrationVersion(tx),
        rowCounts: Object.fromEntries(names.map((n) => [n, tables[n]!.length])),
        attachments: attachmentManifest(tables.personnel_attachments ?? []),
        checksum: '',
      };
      const result: TenantBackup = { manifest, platform, tables };
      result.manifest.checksum = backupChecksum(result);
      return result;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  await platformAudit(db, meta, 'tenant.backup.export', tenantId, {
    takenAt: backup.manifest.takenAt,
    codeVersion: backup.manifest.codeVersion,
    migration: backup.manifest.migration,
    rows: Object.values(backup.manifest.rowCounts).reduce((a, b) => a + b, 0),
    attachments: backup.manifest.attachments.length,
    checksum: backup.manifest.checksum,
  });
  return backup;
}

/** 附件清单：元数据行里登记的对象与内容哈希（对象存储里的文件按此清单核对，见 verifyAttachments）。 */
function attachmentManifest(rows: readonly BackupRow[]): BackupAttachment[] {
  return rows
    .map((r) => ({
      id: String(r.id),
      employeeId: String(r.employee_id),
      sha256: String(r.sha256),
      byteSize: Number(r.byte_size),
      status: String(r.status),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 对象存储的只读端口：按附件 ID 返回实际内容的 SHA-256，找不到返回 null（部署时接入真实存储）。 */
export interface AttachmentStore {
  sha256(attachmentId: string): Promise<string | null>;
}

export interface AttachmentReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly missing: string[];
  readonly mismatched: string[];
}

/** 逐个核对附件：待清理（pending_cleanup）的不要求存在；其余缺失或哈希不符都判不通过。 */
export async function verifyAttachments(
  attachments: readonly BackupAttachment[],
  store: AttachmentStore,
): Promise<AttachmentReport> {
  const missing: string[] = [];
  const mismatched: string[] = [];
  const live = attachments.filter((a) => a.status !== 'pending_cleanup');
  for (const attachment of live) {
    const actual = await store.sha256(attachment.id);
    if (actual === null) missing.push(attachment.id);
    else if (actual !== attachment.sha256) mismatched.push(attachment.id);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, checked: live.length, missing, mismatched };
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

async function insertRows(tx: Tx, table: string, rows: readonly BackupRow[]) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = JSON.stringify(rows.slice(i, i + INSERT_BATCH));
    await tx.execute(sql`
      INSERT INTO ${ident(table)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(table)}, ${batch}::jsonb)`);
  }
}

export interface ImportReport {
  readonly tenantId: string;
  readonly rowCounts: Record<string, number>;
  /** 恢复时由 pending 改记为 unknown 的在途事件 / 通知条数（不补发）。 */
  readonly unknownEvents: number;
}

/** 导入前的完整性校验：格式、迁移版本（必须与目标库完全一致）、校验和、目标库中尚无该租户。 */
async function assertImportable(tx: Tx, backup: TenantBackup) {
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
  const [exists] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM tenants WHERE id = ${manifest.tenantId}::uuid
      OR code = ${String(backup.platform.tenants[0]?.code ?? '')}`),
  );
  if (exists) throw new BackupIntegrityError('TENANT_EXISTS', '目标库已有该租户，恢复只导入到隔离环境（新库）');
}

/**
 * 把备份导入隔离环境：租户状态一律置为 restoring（除平台方外拒绝访问，DEC-061），由业务层完成隔离校验与授权对账后
 * 再开放。整个导入是一个事务，任何一步失败即回滚，隔离环境保持为空。
 */
export async function importTenantBackup(db: Db, backup: TenantBackup): Promise<ImportReport> {
  const tenantId = backup.manifest.tenantId;
  return db.transaction(async (tx) => {
    await assertImportable(tx, backup);
    await setTenant(tx, tenantId);
    const names = await tenantTables(tx);
    for (const table of Object.keys(backup.tables)) {
      if (!names.includes(table)) throw new BackupIntegrityError('FORMAT_UNSUPPORTED', `目标库没有表 ${table}`);
    }
    const fks = await foreignKeys(tx, names);
    for (const fk of fks) await tx.execute(sql`ALTER TABLE ${ident(fk.table)} DROP CONSTRAINT ${ident(fk.name)}`);
    for (const table of names) await tx.execute(sql`ALTER TABLE ${ident(table)} DISABLE TRIGGER USER`);

    const accounts = JSON.stringify(backup.platform.users);
    await tx.execute(sql`
      INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, ${accounts}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO system_settings SELECT * FROM jsonb_populate_recordset(NULL::system_settings,
        ${JSON.stringify(backup.platform.systemSettings)}::jsonb)
      ON CONFLICT (key) DO NOTHING`);
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
    return { tenantId, rowCounts, unknownEvents };
  });
}

export interface IsolationReport {
  readonly ok: boolean;
  /** 不属于该租户的行数（任何租户表）。 */
  readonly foreignRows: number;
  /** 隔离环境中的租户数（应为 1）。 */
  readonly tenants: number;
  /** 不在备份引用清单内的全局账号数。 */
  readonly foreignUsers: number;
  /** 行数与备份清单不一致的表。 */
  readonly countMismatches: string[];
}

class Rollback extends Error {
  constructor(readonly report: IsolationReport) {
    super('rollback');
  }
}

/**
 * 隔离校验：在隔离环境里确认只有该租户的数据（无跨租户数据）且行数与备份清单一致。为了看见“不属于该租户”的行，
 * 事务内临时对表属主取消 FORCE RLS，读完整体回滚（不改动任何结构或数据）。
 */
export async function verifyTenantIsolation(db: Db, backup: TenantBackup): Promise<IsolationReport> {
  const tenantId = backup.manifest.tenantId;
  try {
    await db.transaction(async (tx) => {
      const names = await tenantTables(tx);
      let foreignRows = 0;
      const countMismatches: string[] = [];
      for (const table of names) {
        await tx.execute(sql`ALTER TABLE ${ident(table)} NO FORCE ROW LEVEL SECURITY`);
        const [row] = rowsOf<{ foreign: number; own: number }>(
          await tx.execute(sql`
            SELECT count(*) FILTER (WHERE tenant_id IS DISTINCT FROM ${tenantId}::uuid)::int AS "foreign",
                   count(*) FILTER (WHERE tenant_id = ${tenantId}::uuid)::int AS "own"
              FROM ${ident(table)}`),
        );
        foreignRows += row!.foreign;
        if (row!.own !== (backup.manifest.rowCounts[table] ?? 0)) countMismatches.push(table);
      }
      const [counts] = rowsOf<{ tenants: number; users: number }>(
        await tx.execute(sql`
          SELECT (SELECT count(*)::int FROM tenants) AS tenants,
                 (SELECT count(*)::int FROM users
                   WHERE NOT (id::text = ANY(${textArray(backup.platform.users.map((u) => String(u.id)))})))
                   AS users`),
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

/** 平台审计（备份 / 恢复各步骤）。恢复写在隔离环境里，平台运营账号可能不在那里，操作人记在 after 中。 */
export async function platformAudit(
  db: Db,
  meta: PlatformCommandMeta,
  action: string,
  tenantId: string,
  after: Record<string, unknown>,
  options: { readonly actorInTarget?: boolean } = {},
): Promise<void> {
  const actorInTarget = options.actorInTarget ?? true;
  await withPlatform(db, async (tx) => {
    await tx.insert(platformAuditEvents).values({
      actorUserId: actorInTarget ? meta.actorUserId : null,
      action,
      objectType: 'tenant',
      objectId: tenantId,
      before: null,
      after: { ...after, operatorUserId: meta.actorUserId },
      commandId: meta.commandId,
      subjectTenantId: tenantId,
    });
  });
}

const CIPHER = 'aes-256-gcm';
const MAGIC = Buffer.from('ITB1');

/** 备份加密封装（DEC-061 传输与存储加密）：AES-256-GCM，密钥 32 字节，只放在密钥管理里，不入库不入仓。 */
export function sealBackup(backup: TenantBackup, key: Buffer): Buffer {
  if (key.length !== 32) throw new TypeError('备份密钥必须是 32 字节');
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(backup), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function openBackup(sealed: Buffer, key: Buffer): TenantBackup {
  try {
    if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error('magic');
    const decipher = createDecipheriv(CIPHER, key, sealed.subarray(4, 16));
    decipher.setAuthTag(sealed.subarray(16, 32));
    const body = Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
    return JSON.parse(body.toString('utf8')) as TenantBackup;
  } catch {
    throw new BackupIntegrityError('DECRYPT_FAILED', '备份无法解密：密钥不对或内容被篡改');
  }
}
