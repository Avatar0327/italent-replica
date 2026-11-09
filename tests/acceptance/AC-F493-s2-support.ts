/**
 * F-493 S2 验收夹具：全部读写放进租户 / 平台的 withTenant / withPlatform，普通角色（app_owner，F-212）下同样通过。
 */
import { randomUUID } from 'node:crypto';
import { sql, withPlatform, withTenant, type Db } from '@italent/db';
import { pgErrorCode } from '@italent/testkit';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export interface ImportAccount {
  readonly account_id: string;
  readonly login_assigned: boolean;
}

/** 在租户上下文调用 tenant_provision_import_account（设计 §4.5）。 */
export async function provisionImportAccount(
  db: Db,
  tenantId: string,
  actor: string,
  contactEmail: string,
  displayName = '合成导入人员',
  commandId = `f493s2-${uniqueSuffix()}`,
): Promise<ImportAccount> {
  const result = await withTenant(db, tenantId, (tx) =>
    tx.execute(
      sql`SELECT * FROM tenant_provision_import_account(${contactEmail}::text, ${displayName}::text,
        ${actor}::uuid, ${commandId}::text)`,
    ),
  );
  return rowsOf<ImportAccount>(result)[0]!;
}

/** 平台视角读账号（users 表对应用角色不可见）。 */
export async function readUsers(db: Db, ids: readonly string[]) {
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return withPlatform(db, async (tx) =>
    rowsOf<{ id: string; email: string | null; display_name: string; status: string; revision: number }>(
      await tx.execute(sql`SELECT id, email, display_name, status, revision FROM users WHERE id IN (${list})`),
    ),
  );
}

export async function userCount(db: Db): Promise<number> {
  const result = await withPlatform(db, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM users`));
  return rowsOf<{ n: number }>(result)[0]!.n;
}

/** 执行一条语句，返回抛出的 SQLSTATE（成功返回 undefined）。 */
export async function stateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return pgErrorCode(error);
  }
}

export async function seedTenant(db: Db, label: string) {
  const { tenant, user } = await seedTenantWithMember(db, `${label}-${uniqueSuffix()}`);
  return { tenantId: tenant.id, userId: user.id };
}

/** 在租户里插一个批次（最少列）。 */
export async function insertBatch(
  db: Db,
  tenantId: string,
  submittedBy: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const values = {
    command_id: `cmd-${uniqueSuffix()}`,
    file_name: '合成导入.xlsx',
    status: 'queued',
    total: 3,
    ...over,
  };
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO exit_import_batches
      (tenant_id, id, command_id, submitted_by, file_name, status, total)
      VALUES (${tenantId}, ${id}, ${values.command_id as string}, ${submittedBy}, ${values.file_name as string},
        ${values.status as string}, ${values.total as number})`),
  );
  return id;
}
