/**
 * 恢复的授权对账（DEC-061“授权对账”；PR #60 第二轮 P2-2 / P2-3）：恢复出的业务数据停在备份时点，但**授权一律以现网
 * 当前有效状态为准**——备份之后撤销的授权、关闭的数据权限（含 DEC-121 的看全部）、收紧的字段权限、停用的账号都不得
 * 因恢复而复活。做法是把现网该租户的授权子图（成员关系、身份与对象 / 字段 / 按钮权限、授权、企业管理员、许可、
 * 管理单元、用户范围、身份数据权限、数据权限策略、动态授权、用户与人员绑定）原样镜像到隔离库：
 *   - 现网没有的行删除；两边都有但不同的行改成现网的值；
 *   - 现网有、隔离库没有的行补入；它引用的业务对象在备份时点还不存在（如之后新建的组织）时跳过——跳过只会更窄；
 *   - 删除被业务数据引用而做不到的，列入 problems，阻止开放。
 * restore 与 open 各执行一次（open 前重新读取现网，P2-3）。全局账号按现网同步状态与资料（停用账号不复活）。
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  type BackupRow,
  canonical,
  foreignKeys,
  ident,
  migrationVersion,
  type MigrationVersion,
  platformRows,
  readTable,
  referencedValues,
  rowsOf,
  setTenant,
  tenantTables,
} from './tenant-backup.js';
import type { Tx } from './tenant-context.js';

/** 授权子图的表（权限模块与成员关系）；业务数据表不在其中。 */
export const AUTHORIZATION_TABLES = [
  'tenant_memberships',
  'permission_profiles',
  'permission_profile_apps',
  'permission_profile_objects',
  'permission_profile_fields',
  'permission_profile_buttons',
  'permission_grants',
  'permission_admins',
  'permission_admin_grantable_roles',
  'permission_admin_grantable_profiles',
  'license_pools',
  'license_seats',
  'permission_mous',
  'permission_mou_org_refs',
  'permission_user_app_scopes',
  'permission_identity_scopes',
  'permission_scope_apps',
  'permission_scope_policies',
  'permission_scope_policy_rules',
  'permission_dynamic_org_grants',
  'permission_user_person_links',
] as const;

export interface AuthorizationSnapshot {
  readonly tenantId: string;
  readonly capturedAt: string;
  readonly migration: MigrationVersion;
  readonly tables: Record<string, BackupRow[]>;
  /** 授权子图引用到的全局账号（现网当前资料与状态）。 */
  readonly users: BackupRow[];
}

/** 读取现网该租户的授权子图（只读、可重复读的一致快照）。 */
export async function captureAuthorization(db: Db, tenantId: string): Promise<AuthorizationSnapshot> {
  return db.transaction(
    async (tx) => {
      await setTenant(tx, tenantId);
      const present = await tenantTables(tx);
      const names = AUTHORIZATION_TABLES.filter((t) => present.includes(t));
      const tables: Record<string, BackupRow[]> = {};
      for (const name of names) tables[name] = await readTable(tx, name, tenantId);
      const users = await platformRows(
        tx,
        'users',
        'id',
        referencedValues(tables, await foreignKeys(tx, names), 'users'),
      );
      const [now] = rowsOf<{ at: string }>(await tx.execute(sql`SELECT now()::text AS at`));
      return { tenantId, capturedAt: now!.at, migration: await migrationVersion(tx), tables, users };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export interface MirrorProblem {
  readonly reason: string;
  readonly table?: string;
  readonly key?: string;
  readonly userId?: string;
  /** 失败原因（机器可读的错误码或数据库错误码），供人工处理时定位。 */
  readonly detail?: string;
}

export interface MirrorReport {
  /** 每张表改动的行数（删 + 改 + 补）。 */
  readonly changed: Record<string, number>;
  /** 现网有、但引用的业务对象在备份时点不存在而跳过的行数（只会更窄）。 */
  readonly skipped: number;
  readonly problems: MirrorProblem[];
}

async function primaryKey(tx: Tx, table: string): Promise<string[]> {
  return rowsOf<{ name: string }>(
    await tx.execute(sql`
      SELECT a.attname AS name FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ${table}::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey::int2[], a.attnum)`),
  ).map((r) => r.name);
}

/** 按外键依赖排序（被引用的在前）；自引用不计入。 */
async function dependencyOrder(tx: Tx, names: readonly string[]): Promise<string[]> {
  const fks = await foreignKeys(tx, names);
  const order: string[] = [];
  const pending = new Set(names);
  while (pending.size > 0) {
    const ready = [...pending].filter((t) =>
      fks.every((fk) => fk.table !== t || fk.target === t || !pending.has(fk.target)),
    );
    if (ready.length === 0) throw new Error(`授权表之间存在外键环：${[...pending].join(', ')}`);
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }
  return order;
}

const keyOf = (row: BackupRow, pk: readonly string[]) => canonical(pk.map((c) => row[c] ?? null));

const match = (pk: readonly string[]) =>
  sql.join(
    pk.map((c) => sql`x.${ident(c)} IS NOT DISTINCT FROM r.${ident(c)}`),
    sql` AND `,
  );

/** 在保存点里执行一步；失败只回滚这一步并返回错误（不中断整个对账事务）。 */
async function attempt(tx: Tx, step: (sp: Tx) => Promise<unknown>): Promise<unknown> {
  try {
    await tx.transaction(async (sp) => {
      await step(sp);
    });
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * 把现网授权子图镜像到隔离库（调用方事务内，已设 app.tenant_id，表属主身份）。镜像期间暂时停用这些表上的业务触发器
 * （它们约束的是租户内的业务写入路径），外键始终有效；异常管理员相关的保护由调用方随后按 DEC-098 / 123 处理。
 */
export async function mirrorAuthorization(tx: Tx, snapshot: AuthorizationSnapshot): Promise<MirrorReport> {
  const problems: MirrorProblem[] = [];
  const target = await migrationVersion(tx);
  if (target.count !== snapshot.migration.count || target.lastHash !== snapshot.migration.lastHash) {
    return { changed: {}, skipped: 0, problems: [{ reason: 'LIVE_MIGRATION_VERSION_MISMATCH' }] };
  }
  await setTenant(tx, snapshot.tenantId);
  const present = await tenantTables(tx);
  const names = await dependencyOrder(
    tx,
    AUTHORIZATION_TABLES.filter((t) => present.includes(t)),
  );
  await syncUsers(tx, snapshot.users);
  for (const table of names) await tx.execute(sql`ALTER TABLE ${ident(table)} DISABLE TRIGGER USER`);

  const changed: Record<string, number> = {};
  const plans = new Map<string, { pk: string[]; live: Map<string, BackupRow>; restored: Map<string, BackupRow> }>();
  for (const table of names) {
    const pk = await primaryKey(tx, table);
    const index = (rows: BackupRow[]) => new Map(rows.map((r) => [keyOf(r, pk), r]));
    plans.set(table, {
      pk,
      live: index(snapshot.tables[table] ?? []),
      restored: index(await readTable(tx, table, snapshot.tenantId)),
    });
  }
  // 先删（子表在前），再改，最后补（父表在前，自引用多轮）
  for (const table of [...names].reverse()) {
    const { pk, live, restored } = plans.get(table)!;
    for (const [key, row] of restored) {
      if (live.has(key)) continue;
      const error = await attempt(tx, (sp) =>
        sp.execute(sql`DELETE FROM ${ident(table)} x USING jsonb_populate_record(NULL::${ident(table)},
          ${JSON.stringify(row)}::jsonb) r WHERE ${match(pk)}`),
      );
      if (error) problems.push({ reason: 'DELETE_BLOCKED', table, key });
      else changed[table] = (changed[table] ?? 0) + 1;
    }
  }
  for (const table of names) {
    const { pk, live, restored } = plans.get(table)!;
    for (const [key, row] of live) {
      const current = restored.get(key);
      if (!current || canonical(current) === canonical(row)) continue;
      const columns = Object.keys(row).filter((c) => !pk.includes(c));
      const set = sql.join(
        columns.map((c) => sql`${ident(c)} = r.${ident(c)}`),
        sql`, `,
      );
      const error = await attempt(tx, (sp) =>
        sp.execute(sql`UPDATE ${ident(table)} x SET ${set} FROM jsonb_populate_record(NULL::${ident(table)},
          ${JSON.stringify(row)}::jsonb) r WHERE ${match(pk)}`),
      );
      if (error) problems.push({ reason: 'UPDATE_BLOCKED', table, key });
      else changed[table] = (changed[table] ?? 0) + 1;
    }
  }
  let skipped = 0;
  for (const table of names) {
    const { live, restored } = plans.get(table)!;
    let missing = [...live].filter(([key]) => !restored.has(key)).map(([, row]) => row);
    for (let progress = true; progress && missing.length > 0;) {
      progress = false;
      const left: BackupRow[] = [];
      for (const row of missing) {
        const error = await attempt(tx, (sp) =>
          sp.execute(sql`INSERT INTO ${ident(table)} SELECT * FROM jsonb_populate_record(NULL::${ident(table)},
            ${JSON.stringify(row)}::jsonb)`),
        );
        if (error) left.push(row);
        else {
          progress = true;
          changed[table] = (changed[table] ?? 0) + 1;
        }
      }
      missing = left;
    }
    skipped += missing.length;
  }
  for (const table of names) await tx.execute(sql`ALTER TABLE ${ident(table)} ENABLE TRIGGER USER`);
  return { changed, skipped, problems };
}

/** 全局账号：现网的资料与状态覆盖隔离库（停用的不复活）；授权子图新引用的账号补入。 */
async function syncUsers(tx: Tx, users: readonly BackupRow[]) {
  if (users.length === 0) return;
  await tx.execute(sql`
    INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, ${JSON.stringify(users)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
      status = EXCLUDED.status, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`);
}
