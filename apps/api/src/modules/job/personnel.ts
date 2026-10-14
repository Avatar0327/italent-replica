import { soleOtherPositionManager } from '../employment/field-derivations.js';
import { isUuid, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { JobRecord } from './read-model.js';
import { auditJob } from './store.js';
import type {
  JobFields,
  JobIncumbent,
  JobPersonnelGateway,
  JobWriteContext,
  ManagerSyncResult,
  ManagerSyncSkip,
  PositionChangeOptions,
} from './types.js';

/**
 * DEC-074 已解除：人员数据端口（job/employment-port.ts）接入后，停用职位与按职位树同步直线经理都按真实任职判定，
 * 在岗口径为生效日主职、生效、非离职 / 退休的任职（Q-M0-15，`18` §11）。
 */
export async function applyPositionPersonnelRules(
  tx: Tx,
  ctx: JobWriteContext,
  current: JobRecord,
  fields: JobFields,
  options: PositionChangeOptions,
  gateway: JobPersonnelGateway,
): Promise<ManagerSyncResult | undefined> {
  if (current.enabled && (!fields.enabled || fields.stopDate < current.stopDate)) {
    const asOf = !fields.enabled ? fields.startDate : dayAfter(fields.stopDate);
    const query = { tenantId: ctx.tenantId, positionId: current.id, asOf, limit: 1 };
    const incumbents = await gateway.listIncumbents(tx, query);
    assertIncumbents(incumbents);
    // DEC-016：有在岗人员的职位禁止停用，不做自动转岗。
    if (incumbents.length) {
      throw new AppError('CONFLICT', '职位有在岗人员，禁止停用', { reason: 'POSITION_HAS_INCUMBENTS' });
    }
  }
  // docs/02_业务建模/19 §3.1：「调整员工直线经理」是本次变更的选项（默认否），只在改了上级职位时生效。
  if (!options.adjustEmployeeDirectManager || current.directParentId === fields.directParentId) return undefined;
  return synchronizeManagers(tx, ctx, current, fields, gateway);
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
): Promise<ManagerSyncResult | undefined> {
  if (typeof fields.directParentId !== 'string') return undefined;
  const source = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: fields.directParentId,
    asOf: fields.startDate,
    limit: 2,
  });
  assertIncumbents(source);
  if (source.length !== 1) return undefined;
  const directManagerId = source[0]!.employeeId;
  // W-416：只作用于生效日当天在本职位上的员工；历史记录不改。
  const targets = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: current.id,
    asOf: fields.startDate,
  });
  assertIncumbents(targets);
  const skipped: ManagerSyncSkip[] = [];
  for (const assignment of targets) {
    // DEC-131：员工本人就是唯一在岗人时跳过（不新增、不自任经理），并在保存结果逐人告知。原站未实测。
    // R1 只有主职任职，同一员工不能同时在本职位和新上级职位，真实端口下此分支要到兼职（R2）后才会出现。
    if (
      !soleOtherPositionManager(
        source.map((item) => item.employeeId),
        assignment.employeeId,
      )
    ) {
      skipped.push({
        employeeId: assignment.employeeId,
        assignmentId: assignment.assignmentId,
        reason: 'EMPLOYEE_IS_SOLE_MANAGER',
      });
      continue;
    }
    // DEC-132：经理本来就是此人也照样新增（AC-JOB-05“各新增一条”、原站“是否新增任职”锁定为是）。
    // 该边界原站未实测，属规格解释。范围外的员工由端口判定后跳过（P2-1），不写任职也不写同步审计。
    const change = {
      assignmentId: assignment.assignmentId,
      employeeId: assignment.employeeId,
      expectedRevision: assignment.revision,
      effectiveDate: fields.startDate,
      directManagerId,
      ...POSITION_MANAGER_SYNC_RECORD,
    };
    const outcome = await gateway.appendManagerVersion(tx, ctx, change);
    if (outcome?.skipped) {
      skipped.push({
        employeeId: assignment.employeeId,
        assignmentId: assignment.assignmentId,
        reason: outcome.skipped,
      });
      continue;
    }
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
  return { skipped };
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
