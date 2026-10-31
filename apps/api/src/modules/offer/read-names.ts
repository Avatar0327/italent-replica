/** F-319 / DEC-683③：按租户时区今天取名称；只处理已通过 Offer 范围检查的行。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { rowsOf } from '../approval/context.js';
import type { OfferContext } from './context.js';

type NameContext = Pick<OfferContext, 'tenantId' | 'now' | 'timezone'>;
interface DepartmentName {
  readonly id: string;
  readonly name: string;
  readonly fullName: string;
}

/** 邮件正文与列表 / 详情共用；同日起效的版本按 versionNo 决胜，与 F-234BE 口径一致。 */
export async function offerDepartmentNames(tx: Tx, ctx: NameContext, ids: readonly string[]) {
  if (!ids.length) return new Map<string, DepartmentName>();
  const rows = rowsOf<DepartmentName>(
    await tx.execute(sql`SELECT DISTINCT ON (org_id) org_id AS id, name, full_name AS "fullName"
      FROM org_versions WHERE tenant_id = ${ctx.tenantId} AND org_id = ANY(${`{${ids.join(',')}}`}::uuid[])
        AND start_date <= ${tenantLocalDate(ctx.now, ctx.timezone)}::date
      ORDER BY org_id, start_date DESC, version_no DESC`),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function jobNames(
  tx: Tx,
  ctx: NameContext,
  table: 'job_position_versions' | 'job_post_versions',
  ids: readonly string[],
) {
  if (!ids.length) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`SELECT DISTINCT ON (object_id) object_id AS id, name
      FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId}
        AND object_id = ANY(${`{${ids.join(',')}}`}::uuid[])
        AND start_date <= ${tenantLocalDate(ctx.now, ctx.timezone)}::date
      ORDER BY object_id, start_date DESC, version_no DESC`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function managerNames(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`SELECT id, name FROM employment_employees
      WHERE tenant_id = ${tenantId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function senderNames(tx: Tx, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  // sentBy 是账号 ID（不是员工 ID）；受控函数只回答当前事务租户的成员，禁止直接读平台 users。
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(
      sql`SELECT account_id AS id, display_name AS name FROM tenant_member_accounts(${`{${ids.join(',')}}`}::uuid[])`,
    ),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 每页至多五次名称 SQL，重复 ID 去重；无关联 / 已删除 / 无当前版本统一返回 null。 */
export async function withOfferNames<T extends Readonly<Record<string, unknown>>>(
  tx: Tx,
  ctx: NameContext,
  dtos: readonly T[],
) {
  const ids = (field: string) => [
    ...new Set(dtos.flatMap((row) => (typeof row[field] === 'string' ? [row[field]] : []))),
  ];
  const departments = await offerDepartmentNames(tx, ctx, ids('departmentId'));
  const positions = await jobNames(tx, ctx, 'job_position_versions', ids('positionId'));
  const posts = await jobNames(tx, ctx, 'job_post_versions', ids('postId'));
  const managers = await managerNames(tx, ctx.tenantId, ids('directManagerId'));
  const senders = await senderNames(tx, ids('sentBy'));
  const key = (row: T, field: string) => (typeof row[field] === 'string' ? row[field] : '');
  return dtos.map((row) => ({
    ...row,
    departmentName: departments.get(key(row, 'departmentId'))?.name ?? null,
    departmentFullName: departments.get(key(row, 'departmentId'))?.fullName ?? null,
    positionName: positions.get(key(row, 'positionId')) ?? null,
    postName: posts.get(key(row, 'postId')) ?? null,
    directManagerName: managers.get(key(row, 'directManagerId')) ?? null,
    sentByName: senders.get(key(row, 'sentBy')) ?? null,
  }));
}
