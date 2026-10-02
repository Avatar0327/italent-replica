import { isUuid, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { JobRecord } from './read-model.js';
import { readJobSettings } from './settings.js';
import { auditJob } from './store.js';
import type { JobFields, JobIncumbent, JobPersonnelGateway, JobWriteContext } from './types.js';

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
  const settings = await readJobSettings(tx, ctx.tenantId, fields.startDate);
  if (!settings.adjustEmployeeDirectManager || current.directParentId === fields.directParentId) return;
  await synchronizeManagers(tx, ctx, current, fields, gateway);
}

async function synchronizeManagers(
  tx: Tx,
  ctx: JobWriteContext,
  current: JobRecord,
  fields: JobFields,
  gateway: JobPersonnelGateway,
): Promise<void> {
  // TODO(需取证 Q-M0-14): 明确无在岗人、多在岗人及移除上级的经理来源和实际同步范围。
  if (typeof fields.directParentId !== 'string') throw unresolvedManager();
  const source = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: fields.directParentId,
    asOf: fields.startDate,
  });
  assertIncumbents(source);
  if (source.length !== 1) throw unresolvedManager();
  const directManagerId = source[0]!.employeeId;
  const targets = await gateway.listIncumbents(tx, {
    tenantId: ctx.tenantId,
    positionId: current.id,
    asOf: fields.startDate,
  });
  assertIncumbents(targets);
  for (const assignment of targets) {
    if (assignment.directManagerId === directManagerId) continue;
    await gateway.appendManagerVersion(tx, ctx, {
      assignmentId: assignment.assignmentId,
      employeeId: assignment.employeeId,
      expectedRevision: assignment.revision,
      effectiveDate: fields.startDate,
      directManagerId,
    });
    await auditJob(
      tx,
      ctx,
      'job.manager.synchronize',
      'employment_assignment',
      assignment.assignmentId,
      {
        directManagerId: assignment.directManagerId,
        revision: assignment.revision,
      },
      { directManagerId, revision: assignment.revision + 1, sourcePositionId: fields.directParentId },
    );
  }
}

function unresolvedManager(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', '上级职位经理来源尚不能唯一确定', { reason: 'MANAGER_SOURCE_UNRESOLVED' });
}

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
