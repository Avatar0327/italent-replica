import { randomUUID } from 'node:crypto';
import { sql, type Db, type Tx } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT, SUBSETS, type SubsetKind } from '@italent/domain';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import {
  audit,
  assertRevision,
  camel,
  insert,
  lockPerson,
  rows,
  update,
  type PersonnelContext,
  type Row,
} from './store.js';
import { loadSubset, saveSubset } from './subsets.js';
import { subsetInput } from './validation.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';

export interface ChangeInput {
  readonly employeeId: string;
  readonly subset: SubsetKind;
  readonly recordId?: string;
  readonly targetRevision?: number;
  readonly values: Row;
}
export async function requireSelf(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [link] = rows(
    await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
    WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId} AND employee_id=${employeeId}::uuid LIMIT 1`),
  );
  if (!link) throw new AppError('NOT_FOUND', '个人信息不存在');
}
export async function createChange(tx: Tx, ctx: PersonnelContext, input: ChangeInput) {
  assertRevision(ctx.expectedRevision, 0);
  await requireSelf(tx, ctx, input.employeeId);
  await lockPerson(tx, ctx, input.employeeId);
  if (input.recordId) {
    const record = await loadSubset(tx, ctx, input.employeeId, input.subset, input.recordId);
    assertRevision(input.targetRevision ?? 0, Number(record.revision));
  } else assertRevision(input.targetRevision ?? 0, 0);
  const row = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId: input.employeeId,
    subset: input.subset,
    recordId: input.recordId ?? null,
    targetRevision: input.targetRevision ?? 0,
    revision: 1,
    status: 'pending_approval',
    values: input.values,
    createdBy: ctx.userId,
    commandId: ctx.commandId,
    createdAt: ctx.now.toISOString(),
  };
  await insert(tx, 'personnel_change_requests', { ...row, values: JSON.stringify(row.values) });
  await appendVersion(tx, ctx, row.employeeId, row.id, 1, row.values);
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, input.employeeId, row.id, 1, null, row);
  return row;
}
/** DEC-099：申请载荷按版本留存——首次提交为第 1 版，驳回后同单修正追加新版本。 */
async function appendVersion(tx: Tx, ctx: PersonnelContext, employeeId: string, id: string, no: number, values: Row) {
  await insert(tx, 'personnel_change_request_versions', {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    requestId: id,
    versionNo: no,
    values: JSON.stringify(values),
    createdBy: ctx.userId,
    commandId: ctx.commandId,
    createdAt: ctx.now.toISOString(),
  });
}
/**
 * DEC-099：被驳回的员工信息变更由申请人在同一张单上修正，修正内容合并后追加为新版本、历史保留；
 * 只由审批中心在发起人校验后同事务调用，字段仍受员工自助修改清单与子集校验约束。
 */
export async function correctChangeInTransaction(tx: Tx, ctx: PersonnelContext, id: string, corrections: Row) {
  const initial = await loadChange(tx, ctx, id);
  await lockPerson(tx, ctx, String(initial.employeeId));
  const before = await loadChange(tx, ctx, id);
  if (before.status !== 'pending_approval') throw new AppError('CONFLICT', '申请不在待审批状态');
  if (String(before.createdBy) !== ctx.userId) throw new AppError('FORBIDDEN', '只有申请人可以修正申请');
  const kind = before.subset as SubsetKind;
  const setting = await readEffectiveSetting(tx, ctx.tenantId, 'personnel.self_service_fields');
  const configured = (setting.value as Record<string, unknown>)[kind];
  const allowed = new Set(
    Array.isArray(configured) ? configured.filter((v): v is string => typeof v === 'string') : [],
  );
  if (Object.keys(corrections).some((field) => !allowed.has(field)))
    throw new AppError('FORBIDDEN', '字段不在员工自助修改清单内');
  // 申请行的载荷按 0021 设计不可改，修正只追加版本并推进 revision；生效值取最新版本（currentChangeValues）。
  const values = { ...(await currentChangeValues(tx, ctx, id)), ...subsetInput(kind, corrections, true) };
  const after = { ...before, values, revision: Number(before.revision) + 1 };
  await update(
    tx,
    'personnel_change_requests',
    { revision: after.revision },
    sql`tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
  );
  await appendVersion(tx, ctx, String(before.employeeId), id, after.revision, values);
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, String(before.employeeId), id, after.revision, before, after);
  return after;
}
export async function loadChange(tx: Tx, ctx: PersonnelContext, id: string) {
  const [row] = rows(
    await tx.execute(sql`SELECT * FROM personnel_change_requests
    WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid LIMIT 1`),
  );
  if (!row) throw new AppError('NOT_FOUND', '个人信息变更申请不存在');
  return camel(row);
}
/** 申请当前生效的载荷：最新版本（DEC-099 同单修正后为修正值），无版本记录的旧申请取申请行。 */
export async function currentChangeValues(tx: Tx, ctx: PersonnelContext, id: string): Promise<Row> {
  const [latest] = rows(
    await tx.execute(sql`SELECT values FROM personnel_change_request_versions
    WHERE tenant_id=${ctx.tenantId} AND request_id=${id}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  if (latest) return latest.values as Row;
  return (await loadChange(tx, ctx, id)).values as Row;
}
/**
 * 只由审批中心（R1-T07）在节点鉴权、非自审校验与审批决定持久化后同事务调用。
 * 此函数不代表审批决定，不挂公开 HTTP 路由；用于履行已通过申请的业务落地。
 */
export async function applyApprovedChangeInTransaction(tx: Tx, ctx: PersonnelContext, id: string) {
  const initial = await loadChange(tx, ctx, id);
  await lockPerson(tx, ctx, String(initial.employeeId));
  const before = await loadChange(tx, ctx, id);
  assertRevision(ctx.expectedRevision, Number(before.revision));
  if (before.status !== 'pending_approval') throw new AppError('CONFLICT', '申请不在待审批状态');
  const kind = before.subset as SubsetKind;
  if (!Object.hasOwn(SUBSETS, kind)) throw new AppError('VALIDATION_FAILED', '申请子集不存在');
  const values = subsetInput(kind, await currentChangeValues(tx, ctx, id), true);
  const result = await saveSubset(
    tx,
    { ...ctx, expectedRevision: Number(before.targetRevision) },
    String(before.employeeId),
    kind,
    values,
    before.recordId ? String(before.recordId) : undefined,
    false,
    { type: 'self_service', id },
  );
  const after = { ...before, status: 'applied', revision: Number(before.revision) + 1 };
  await update(
    tx,
    'personnel_change_requests',
    { status: 'applied', revision: after.revision },
    sql`tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
  );
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, String(before.employeeId), id, after.revision, before, after);
  return { ...after, resultId: result.id };
}
/** 审批撤回（R1-T07）：申请关闭为“已撤回”，不写入子集；只由审批中心同事务调用。 */
export async function withdrawChangeInTransaction(tx: Tx, ctx: PersonnelContext, id: string) {
  const initial = await loadChange(tx, ctx, id);
  await lockPerson(tx, ctx, String(initial.employeeId));
  const before = await loadChange(tx, ctx, id);
  if (before.status !== 'pending_approval') throw new AppError('CONFLICT', '申请不在待审批状态');
  const after = { ...before, status: 'withdrawn', revision: Number(before.revision) + 1 };
  await update(
    tx,
    'personnel_change_requests',
    { status: 'withdrawn', revision: after.revision },
    sql`tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
  );
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, String(before.employeeId), id, after.revision, before, after);
  return after;
}
export async function applyApprovedChange(db: Db, ctx: PersonnelContext, id: string) {
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { operation: 'personnel.apply-approved-change', id, revision: ctx.expectedRevision },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await applyApprovedChangeInTransaction(tx, { ...ctx, commandId }, id),
    }),
  });
}
