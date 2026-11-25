/**
 * 16a-2c 人员 / 附件受信撤回端口（设计 R2-T01 §4.1 第 7 条）：采集撤回在锁内调用，把待入职阶段采集写入的
 * 人员资料收回，保留姓名与个人邮箱。调用方必须已锁人、已锁业务头与阶段，并在同一事务里；任一步失败整体回滚。
 *
 * - 本单位经历（任职同步维护）只在这里按“待入职记录的投影”删除，普通 saveSubset 禁删该类行的约束不变；
 * - 其余子集逐行过 runSubsetSavePolicy（带 deleted 标记）再删行，策略可以拒绝；
 * - 附件由 unbindSubsetAttachments 解绑，候选人侧永远不直接写附件引用；
 * - 员工资料追加一条清空后的新版本（版本链，DEC-019 字段审计随 appendEmployee 写入），不覆盖历史版本。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_EDITABLE_FIELDS, EMPLOYEE_REFLECTED_FIELDS, SUBSETS, type SubsetKind } from '@italent/domain';
import { AppError } from '../../errors.js';
import { unbindSubsetAttachments } from '../attachments/subset-binding.js';
import { appendEmployee, employeeSnapshot } from './employee-write.js';
import { runSubsetSavePolicy, type SubsetSource } from './subset-policy.js';
import { persistSubset } from './subsets.js';
import { camel, rows, type PersonnelContext, type Row } from './store.js';

/** 撤回后仍保留的员工字段：姓名与个人邮箱；账号 / 重聘标记不是采集内容，保持原值。 */
const KEEP = new Set([
  'name',
  'displayName',
  'email',
  'allowToLoginIn',
  'isRehire',
  'rehireType',
  'confirmRehireUserId',
]);
const withdrawnRehire = () =>
  new AppError('CONFLICT', '重聘或返聘入职不可撤回', { reason: 'COLLECTION_WITHDRAW_REHIRE' });

async function liveRows(tx: Tx, ctx: PersonnelContext, employeeId: string, kind: SubsetKind): Promise<Row[]> {
  const found = rows(
    await tx.execute(sql`SELECT * FROM ${sql.identifier(SUBSETS[kind].table)}
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND deleted=false ORDER BY id FOR UPDATE`),
  );
  return found.map(camel);
}

async function deleteRow(
  tx: Tx,
  ctx: PersonnelContext,
  kind: SubsetKind,
  before: Row,
  source: SubsetSource,
  policy: boolean,
) {
  const row: Row = {
    ...before,
    revision: Number(before.revision) + 1,
    deleted: true,
    sourceType: source.type,
    sourceId: source.id,
    commandId: ctx.commandId,
  };
  if (policy) await runSubsetSavePolicy(tx, ctx, kind, { before, row, deleted: true, source });
  await unbindSubsetAttachments(tx, ctx, kind, String(before.id), before);
  await persistSubset(tx, ctx, kind, before, row);
}

/** 本单位经历：只删待入职记录自己的投影；别的任职记录留有投影说明这个人有过任职，按重聘拒绝。 */
async function removeProjection(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  recordId: string,
  src: SubsetSource,
) {
  for (const before of await liveRows(tx, ctx, employeeId, 'jobhistory')) {
    if (!before.isThisCompany) continue;
    if (String(before.employmentRecordId) !== recordId) throw withdrawnRehire();
    // 任职同步维护的投影，与 syncOne 一致不经子集策略钩子（subset-policy 直写边界）
    await deleteRow(tx, ctx, 'jobhistory', before, { ...src, type: 'employment_sync' }, false);
  }
}

/** 员工资料清空的补丁：可编辑与反射字段置空（保留 KEEP），自定义字段逐个置空。 */
function clearPatch(customFields: Row | undefined): Row {
  const codes = [...EMPLOYEE_EDITABLE_FIELDS.filter((f) => !f.system), ...EMPLOYEE_REFLECTED_FIELDS.slice(0, 8)];
  const patch: Row = Object.fromEntries(codes.filter((f) => !KEEP.has(f.code)).map((f) => [f.code, null]));
  const custom = Object.fromEntries(Object.keys(customFields ?? {}).map((id) => [id, null]));
  return Object.keys(custom).length ? { ...patch, customFields: custom } : patch;
}

export async function withdrawPersonnelData(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  pendingRecordId: string,
  collectionTaskId: string,
): Promise<void> {
  const source: SubsetSource = { type: 'info_collection', id: collectionTaskId };
  await removeProjection(tx, ctx, employeeId, pendingRecordId, source);
  for (const kind of Object.keys(SUBSETS) as SubsetKind[]) {
    for (const before of await liveRows(tx, ctx, employeeId, kind))
      await deleteRow(tx, ctx, kind, before, source, true);
  }
  const previous = await employeeSnapshot(tx, ctx, employeeId);
  const custom = previous?.customFields as Row | undefined;
  // 检查 revision 已由上层业务头锁与期望修订承担，这里整版追加，不再单独比对
  await appendEmployee(tx, ctx, employeeId, clearPatch(custom), false);
}
