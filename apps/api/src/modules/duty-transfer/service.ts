/**
 * 职责转交菜单的写服务（R2-T09a；DEC-602② / DEC-726 / F-408；规格 `30` §补充“菜单立即转交实测”“菜单指定日期转交实测”）。
 * - 立即生效：经单一执行入口 executeDutyItem（DEC-431①）当天执行，记录已完成并写转交时间（W-607：组织新版本启用日 = 当天）；
 * - 指定日期：只记未完成记录（转交时间空、带转交日期），职责不动；到期由定时任务执行（runDueMenuDutyTransfers）；
 * - 待生效期间再次提交同一被转交人：带记录 revision 覆盖（改接收人 / 改日期 / 改为立即），接收人清空即作废（撤回）；
 * - 接收人为空且无待生效记录的条目跳过（原站“部分设置”）；整批没有可写的条目时 400 DUTY_TRANSFER_EMPTY（第 2 轮 P2-2）。
 * 一次提交整体成功或整体失败（AGENTS §10 批量）；不走审批，不发通知。
 */
import { dutyTransferRecords, sql, type Tx } from '@italent/db';
import {
  type DUTY_TRANSFER_AUDIT_ACTIONS,
  dutyConfirmMessage,
  DUTY_TRANSFER_SOURCE,
  DUTY_TRANSFER_STATUS,
  DUTY_TYPE,
  tenantLocalDate,
} from '@italent/domain';
import { randomUUID } from 'node:crypto';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { ineligibleOrgPeople } from '../employment/org-people.js';
import type { Authorizer } from '../../authorization.js';
import { requireLinkedEmploymentRecord } from '../employment/context.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { findCurrentRecord, rowsOf } from '../employment/read-model.js';
import { lockTransferParticipants } from '../employment/transfer-locks.js';
import type { EmploymentContext, EmploymentScope } from '../employment/types.js';
import { authorizeOrgRole, authorizeSubordinateField } from '../transfer/linkage/access.js';
import { executeDutyItem, type DutyItem } from '../transfer/linkage/duty-execution.js';
import type { DutyRelation, OrgRole } from '../transfer/linkage/input.js';
import { currentDuties, dutyKey, pendingRecords, type Duty, type DutyRecordRow, type DutyTarget } from './duties.js';
import { recordView, type DutyRecordView } from './records.js';

export interface MenuItemInput extends DutyTarget {
  readonly receiverId: string | null;
  readonly revision?: number;
}

export interface MenuSubmitInput {
  readonly timing: 'immediate' | 'scheduled';
  readonly transferDate?: string;
  readonly items: readonly MenuItemInput[];
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** 转交日期：立即 = 租户今天；指定日期须晚于今天（F-408，“不得早于明天”）。合法日历日由路由的 businessDate 先校验。 */
function transferDateOf(ctx: EmploymentContext, input: MenuSubmitInput): string {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if (input.timing === 'immediate') {
    if (input.transferDate !== undefined)
      throw new AppError('VALIDATION_FAILED', '立即生效不能指定转交日期', { reason: 'DUTY_TRANSFER_DATE_UNEXPECTED' });
    return today;
  }
  if (!input.transferDate || input.transferDate <= today)
    throw new AppError('VALIDATION_FAILED', '转交日期须晚于今天', { reason: 'DUTY_TRANSFER_DATE_NOT_FUTURE' });
  return input.transferDate;
}

function checkItems(employeeId: string, items: readonly MenuItemInput[]) {
  const keys = new Set(items.map((item) => dutyKey(item)));
  if (keys.size !== items.length) throw new AppError('VALIDATION_FAILED', '同一职责只能出现一次');
  if (items.some((item) => item.receiverId === employeeId))
    throw new AppError('VALIDATION_FAILED', '接收人不能是被转交人本人', { reason: 'DUTY_TRANSFER_RECEIVER_SELF' });
}

/** 确认信息（只读）：条数、各接收人、DT-R6 提示（接收人已不在职 / 有已通过的离职退休申请）。 */
export async function checkMenuTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string, input: MenuSubmitInput) {
  checkItems(employeeId, input.items);
  const date = transferDateOf(ctx, input);
  // 空接收人不计入（跳过或撤回）；与提交同口径（P2-2）。
  const assigned = input.items.filter((item) => item.receiverId);
  const counts = new Map<string, number>();
  assigned.forEach((item) => counts.set(item.receiverId!, (counts.get(item.receiverId!) ?? 0) + 1));
  const ids = [...counts.keys()];
  const names = await personNames(tx, ctx.tenantId, ids);
  const inactive = new Set(await ineligibleOrgPeople(tx, ctx.tenantId, ids, date));
  const leaving = await leavingPeople(tx, ctx.tenantId, ids);
  const warnings = ids.flatMap((receiverId) =>
    inactive.has(receiverId)
      ? [{ receiverId, reason: 'RECEIVER_NOT_ACTIVE' }]
      : leaving.has(receiverId)
        ? [{ receiverId, reason: 'RECEIVER_LEAVING' }]
        : [],
  );
  const receivers = ids.map((receiverId) => ({
    receiverId,
    name: names.get(receiverId) ?? '',
    count: counts.get(receiverId)!,
  }));
  const message = dutyConfirmMessage(
    assigned.length,
    receivers.map((row) => row.name),
  );
  return { count: assigned.length, receivers, message, warnings };
}

async function personNames(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`SELECT e.id::text AS id,
        ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name
      FROM employment_employees e WHERE e.tenant_id=${tenantId} AND e.id=ANY(${uuidArray(ids)})`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 有已审批通过、尚未生效的离职 / 退休申请的人（DT-R6 提示）。 */
async function leavingPeople(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT DISTINCT b.employee_id::text AS id FROM employment_business_objects b
      JOIN LATERAL (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id
        ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
        ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${tenantId} AND b.employee_id=ANY(${uuidArray(ids)})
        AND p.kind IN ('leave','retirement') AND s.state='approved'`),
  );
  return new Set(rows.map((row) => row.id));
}

export function dutyItemOf(
  target: DutyTarget,
  employeeId: string,
  receiverId: string,
  effectiveDate: string,
): DutyItem {
  const common = { employeeId, receiverId, effectiveDate };
  return target.dutyType === DUTY_TYPE.orgRole
    ? { kind: 'org_role', ...common, orgId: target.orgId!, orgRole: target.orgRole as OrgRole }
    : {
        kind: 'subordinate',
        ...common,
        subordinateId: target.subordinateId!,
        relation: target.relation as DutyRelation,
      };
}

/** 操作人对改写对象的访问（路由在命令事务内按当前权限解析）；定时执行没有操作人，不带。 */
export interface MenuAccess {
  readonly authorize: Authorizer;
  readonly employmentScope: EmploymentScope;
}

/**
 * P1-1 / P1-5 同口径（与联动子项重试一致）：按改写的真实对象与字段授权——组织角色判组织范围与组织角色字段，
 * 下属判任职上级字段，且下属当前任职须在操作人任职范围内（DEC-178，不可见整单拒绝）。
 */
async function authorizeDuty(tx: Tx, ctx: EmploymentContext, access: MenuAccess, target: DutyTarget, today: string) {
  const scoped = { ...ctx, authorize: access.authorize, scope: access.employmentScope };
  if (target.dutyType === DUTY_TYPE.orgRole) {
    await authorizeOrgRole(tx, scoped, {}, target.orgId!, target.orgRole as OrgRole);
    return;
  }
  await authorizeSubordinateField(scoped, target.relation as DutyRelation);
  const record = await findCurrentRecord(tx, ctx.tenantId, target.subordinateId!, today);
  if (record)
    await requireLinkedEmploymentRecord(tx, scoped, target.subordinateId!, record.fields.departmentId, record.id);
}

export async function submitMenuTransfer(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: MenuSubmitInput,
  access: MenuAccess,
) {
  checkItems(employeeId, input.items);
  const date = transferDateOf(ctx, input);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const subordinates = input.items.flatMap((item) => (item.subordinateId ? [item.subordinateId] : []));
  if ((await lockTransferParticipants(tx, ctx, employeeId, subordinates)) === 'missing')
    throw new AppError('NOT_FOUND', '员工不存在');
  const duties = new Map((await currentDuties(tx, ctx.tenantId, employeeId, today)).map((d) => [d.key, d]));
  const pending = await pendingRecords(tx, ctx.tenantId, employeeId, true);
  const batchId = randomUUID();
  const saved: DutyRecordRow[] = [];
  for (const item of input.items) {
    const key = dutyKey(item);
    const existing = pending.get(key);
    if ((existing?.revision ?? undefined) !== item.revision)
      throw new AppError('REVISION_CONFLICT', '待生效的转交已变化，请刷新后重新提交', {
        reason: 'DUTY_TRANSFER_STALE',
      });
    if (!item.receiverId) {
      // 无待生效记录 = 本条不设置，跳过；有 = 撤回（revision 已在上面核对）。
      if (existing) saved.push(await voidRecord(tx, ctx, existing));
      continue;
    }
    const duty = duties.get(key);
    if (!duty) throw new AppError('VALIDATION_FAILED', '被转交人当前未承担该职责', { reason: 'DUTY_NOT_HELD' });
    await authorizeDuty(tx, ctx, access, duty, today);
    if (input.timing === 'immediate')
      await executeDutyItem(tx, ctx, dutyItemOf(duty, employeeId, item.receiverId, date), { caller: 'menu' });
    else if ((await ineligibleOrgPeople(tx, ctx.tenantId, [item.receiverId], today)).length)
      throw new AppError('VALIDATION_FAILED', '接收人不是在职员工', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    saved.push(await saveRecord(tx, ctx, { duty, existing, receiverId: item.receiverId, date, batchId, input }));
  }
  // 全部为空且都没有待生效记录：没有可写的东西。原站此时的提示未取证，取最保守做法拒绝（见 PR 描述“未决”）。
  if (!saved.length)
    throw new AppError('VALIDATION_FAILED', '请至少为一项职责选择接收人', { reason: 'DUTY_TRANSFER_EMPTY' });
  return { batchId, count: saved.length, records: saved.map(recordView) };
}

async function saveRecord(
  tx: Tx,
  ctx: EmploymentContext,
  args: {
    duty: Duty;
    existing: DutyRecordRow | undefined;
    receiverId: string;
    date: string;
    batchId: string;
    input: MenuSubmitInput;
  },
) {
  const completed = args.input.timing === 'immediate';
  const values = {
    receiverId: args.receiverId,
    transferDate: args.date,
    status: completed ? DUTY_TRANSFER_STATUS.completed : DUTY_TRANSFER_STATUS.unfinished,
    transferAt: completed ? ctx.now : null,
    batchId: args.batchId,
    operatorId: ctx.userId,
    dutyDetails: args.duty.description,
    failureCode: null,
    failureMessage: null,
    failureRule: null,
    updatedAt: ctx.now,
  };
  const [row] = args.existing
    ? await tx
        .update(dutyTransferRecords)
        .set({ ...values, revision: args.existing.revision + 1 })
        .where(sql`tenant_id=${ctx.tenantId} AND id=${args.existing.id}::uuid`)
        .returning()
    : await tx
        .insert(dutyTransferRecords)
        .values({
          ...values,
          tenantId: ctx.tenantId,
          employeeId: args.duty.holderId,
          dutyType: args.duty.dutyType,
          orgId: args.duty.orgId,
          orgRole: args.duty.orgRole,
          subordinateId: args.duty.subordinateId,
          relation: args.duty.relation,
          source: DUTY_TRANSFER_SOURCE.menu,
          createdAt: ctx.now,
        })
        .returning();
  const action = completed ? 'completed' : args.existing ? 'rescheduled' : 'scheduled';
  await auditRecord(tx, ctx, `duty_transfer.menu.${action}`, args.existing ?? null, row!);
  return row!;
}

async function voidRecord(tx: Tx, ctx: EmploymentContext, existing: DutyRecordRow) {
  const [row] = await tx
    .update(dutyTransferRecords)
    .set({ status: DUTY_TRANSFER_STATUS.voided, revision: existing.revision + 1, updatedAt: ctx.now })
    .where(sql`tenant_id=${ctx.tenantId} AND id=${existing.id}::uuid`)
    .returning();
  await auditRecord(tx, ctx, 'duty_transfer.menu.voided', existing, row!);
  return row!;
}

const auditShape = (row: DutyRecordRow) => ({
  employeeId: row.employeeId,
  receiverId: row.receiverId,
  dutyType: row.dutyType,
  dutyDetails: row.dutyDetails,
  status: row.status,
  transferDate: row.transferDate,
  failureCode: row.failureCode,
});

export async function auditRecord(
  tx: Tx,
  ctx: EmploymentContext,
  action: (typeof DUTY_TRANSFER_AUDIT_ACTIONS)[number],
  before: DutyRecordRow | null,
  after: DutyRecordRow,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action,
    objectType: 'duty-transfer-record',
    objectId: after.id,
    before: before ? auditShape(before) : null,
    after: auditShape(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { employeeId: after.employeeId },
  });
}

export type { DutyRecordView };
