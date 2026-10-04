import { isUuid, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { JobRecord } from './read-model.js';
import { auditJob } from './store.js';
import type { JobFields, JobIncumbent, JobPersonnelGateway, JobWriteContext, PositionChangeOptions } from './types.js';

// TODO(需取证 Q-M0-15): 员工主数据和任职版本链未接入前，不得把未知人数假定为零。
export const unavailableJobPersonnel: JobPersonnelGateway = {
  async listIncumbents() {
    throw new AppError('SERVICE_UNAVAILABLE', '职位在岗人员的真实数据端口尚未接入');
  },
  async appendManagerVersion() {
    throw new AppError('SERVICE_UNAVAILABLE', '任职经理版本写入端口尚未接入');
  },
};

export async function applyPositionPersonnelRules(
  tx: Tx,
  ctx: JobWriteContext,
  current: JobRecord,
  fields: JobFields,
  options: PositionChangeOptions,
  gateway: JobPersonnelGateway,
): Promise<void> {
  if (current.enabled && (!fields.enabled || fields.stopDate < current.stopDate)) {
    const asOf = !fields.enabled ? fields.startDate : dayAfter(fields.stopDate);
    const incumbents = await gateway.listIncumbents(tx, { tenantId: ctx.tenantId, positionId: current.id, asOf });
    assertIncumbents(incumbents);
    if (incumbents.length) {
      throw new AppError('CONFLICT', '职位有在岗人员，禁止停用', { reason: 'POSITION_HAS_INCUMBENTS' });
    }
  }
  // docs/02_业务建模/19 §3.1：「调整员工直线经理」是本次变更的选项（默认否），只在改了上级职位时生效。
  if (!options.adjustEmployeeDirectManager || current.directParentId === fields.directParentId) return;
  await synchronizeManagers(tx, ctx, current, fields, gateway);
}

/**
 * 按新上级职位的唯一在岗人同步本职位在岗员工的直线经理（19 §3.1，07 A10 W-414～W-416）。
 * 来源不唯一时整单照常保存、不同步、不新增任职：
 * - 2 人及以上在岗：W-415 实测；
 * - 无人在岗、清空上级职位：未实测，按原站说明“上级职位仅有一人时……自动更新”推定。
 */
async function synchronizeManagers(
  tx: Tx,
  ctx: JobWriteContext,
  current: JobRecord,
  fields: JobFields,
  gateway: JobPersonnelGateway,
): Promise<void> {
  if (typeof fields.directParentId !== 'string') return;
  const source = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: fields.directParentId,
    asOf: fields.startDate,
  });
  assertIncumbents(source);
  if (source.length !== 1) return;
  const directManagerId = source[0]!.employeeId;
  // W-416：只作用于生效日当天在本职位上的员工；历史记录不改。
  const targets = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: current.id,
    asOf: fields.startDate,
  });
  assertIncumbents(targets);
  for (const assignment of targets) {
    // 原站“是否新增任职”被锁定为“是”，经理原本就是此人也照样新增；只跳过员工本人即唯一在岗人的情形，
    // 避免把自己设为直线经理（原站未实测，见 PR 说明）。
    if (assignment.employeeId === directManagerId) continue;
    const change = {
      assignmentId: assignment.assignmentId,
      employeeId: assignment.employeeId,
      expectedRevision: assignment.revision,
      effectiveDate: fields.startDate,
      directManagerId,
      ...POSITION_MANAGER_SYNC_RECORD,
    };
    await gateway.appendManagerVersion(tx, ctx, change);
    await auditJob(
      tx,
      ctx,
      'job.manager.synchronize',
      'employment_assignment',
      assignment.assignmentId,
      { directManagerId: assignment.directManagerId, revision: assignment.revision },
      {
        directManagerId,
        revision: assignment.revision + 1,
        effectiveDate: fields.startDate,
        ...POSITION_MANAGER_SYNC_RECORD,
        sourcePositionId: fields.directParentId,
      },
    );
  }
}

/** W-416：同步经理新增的任职记录业务类型为“组织调整”、变动类型为“职位调整”。 */
const POSITION_MANAGER_SYNC_RECORD = {
  businessKind: 'org_adjustment',
  changeType: 'position_adjustment',
} as const;

function assertIncumbents(incumbents: readonly JobIncumbent[]): void {
  const assignments = new Set<string>();
  for (const row of incumbents) {
    if (
      !isUuid(row.employeeId) ||
      !isUuid(row.assignmentId) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    ) {
      throw new AppError('SERVICE_UNAVAILABLE', '人员数据端口返回的任职标识不合法');
    }
    if (assignments.has(row.assignmentId)) throw new AppError('SERVICE_UNAVAILABLE', '人员数据端口返回重复任职');
    assignments.add(row.assignmentId);
  }
}

function dayAfter(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
