/**
 * 业务适配：把任职申请、人员自助变更申请转换为审批快照（表单值、变更前原值、变化字段、条件取值、路由部门），
 * 并在审批结束时调用各模块已有的可信端口（任职状态机 / 申请落地），与审批写入同事务。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  isApprovalType,
  SUBSETS,
  tenantLocalDate,
  type ApprovalTypeCode,
  type SubsetKind,
} from '@italent/domain';
import { findCurrentRecord, findPredecessor, loadEmploymentBusiness } from '../employment/read-model.js';
import { transitionEmployment } from '../employment/transitions.js';
import { PRESET_FIELD_NAMES, type PresetFields } from '../employment/types.js';
import { updateEmploymentBusiness } from '../employment/write-service.js';
import {
  applyApprovedChangeInTransaction,
  loadChange,
  withdrawChangeInTransaction,
} from '../personnel/change-requests.js';
import { loadSubset } from '../personnel/subsets.js';
import { AppError } from '../../errors.js';
import { approvalError, rowsOf, type ApprovalContext, type Row } from './context.js';

export type BusinessType = 'employment' | 'personnel_change';

export interface BusinessSnapshot {
  readonly approvalType: ApprovalTypeCode;
  readonly businessType: BusinessType;
  readonly businessId: string;
  /** 字段权限所在对象：最小披露与盲审都按该对象的可查看字段判断（DEC-057 / DEC-058）。 */
  readonly fieldObjectCode: string;
  readonly subjectEmployeeId: string | null;
  readonly title: string;
  readonly values: Readonly<Row>;
  readonly originals: Readonly<Row> | null;
  readonly changedFields: readonly string[];
  readonly conditionValues: Readonly<Row>;
  readonly latestDepartmentId: string | null;
  readonly recordDepartmentId: string | null;
}

export interface BusinessAdapter {
  snapshot(tx: Tx, ctx: ApprovalContext, businessId: string, processCode: string | null): Promise<BusinessSnapshot>;
  approved(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  rejected(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  /** 审批侧发起的撤回（业务侧撤回已由业务模块自己迁移状态）。 */
  withdrawn(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  /** 审批侧发起的同单重提（任职申请经任职模块的“提交”重提）。 */
  resubmitted(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  edit(tx: Tx, ctx: ApprovalContext, businessId: string, fields: Readonly<Row>): Promise<void>;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function employeeHeader(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code,name FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '人员不存在');
  return row;
}

async function businessRevision(tx: Tx, tenantId: string, id: string): Promise<number> {
  const [row] = rowsOf<{ revision: number }>(
    await tx.execute(
      sql`SELECT revision FROM employment_business_objects WHERE tenant_id=${tenantId} AND id=${id}::uuid`,
    ),
  );
  if (!row) throw new AppError('NOT_FOUND', '任职业务不存在');
  return Number(row.revision);
}

/** 审批中心以可信身份推进任职状态；不带数据范围（审批不授予范围，DEC-057），由节点规则约束。 */
async function employmentTransition(
  tx: Tx,
  ctx: ApprovalContext,
  id: string,
  action: 'approve' | 'reject' | 'withdraw',
) {
  const expectedRevision = await businessRevision(tx, ctx.tenantId, id);
  await transitionEmployment(tx, { ...ctx, expectedRevision }, { id, action });
}

const employmentAdapter: BusinessAdapter = {
  async snapshot(tx, ctx, businessId, processCode) {
    const asOf = tenantLocalDate(ctx.now, ctx.timezone);
    const business = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, asOf);
    if (!business) throw new AppError('NOT_FOUND', '任职业务不存在');
    if (!isApprovalType(business.kind)) throw approvalError('CONFLICT', 'APPROVAL_TYPE_UNKNOWN', '该业务没有审批类型');
    const type = APPROVAL_TYPES[business.kind];
    const before = await findPredecessor(tx, ctx.tenantId, business.employeeId, business.effectiveDate);
    const current = await findCurrentRecord(tx, ctx.tenantId, business.employeeId, asOf);
    const employee = await employeeHeader(tx, ctx.tenantId, business.employeeId);
    // 人员类型（employType）由任职周期派生、申请载荷不携带（write-service effectiveEmployType），不算本单变化。
    const employType = business.kind === 'intern_regularization' ? 'internal' : before?.fields.employType;
    const fields: PresetFields = { ...business.fields, employType: business.fields.employType ?? employType ?? null };
    const originals: Row | null = before ? { ...before.fields } : null;
    const values: Row = { ...fields, effectiveDate: business.effectiveDate, kind: business.kind, mode: business.mode };
    const ref = (prefix: 'before' | 'record', source: Partial<PresetFields> | undefined) =>
      Object.fromEntries(
        (['departmentId', 'postId', 'positionId', 'levelId'] as const).map((key) => [
          `${prefix}.${key}`,
          source?.[key] ?? null,
        ]),
      );
    return {
      approvalType: business.kind,
      businessType: 'employment',
      businessId,
      fieldObjectCode: type.objectCode,
      subjectEmployeeId: business.employeeId,
      title: `${employee.name}的${type.name}申请`,
      values,
      originals,
      changedFields: PRESET_FIELD_NAMES.filter((field) => !same(fields[field], originals?.[field])),
      conditionValues: {
        processCode: processCode ?? type.defaultProcessCode,
        'business.kind': business.kind,
        'employee.code': employee.code,
        'employee.name': employee.name,
        'record.effectiveDate': business.effectiveDate,
        ...ref('before', before?.fields),
        ...ref('record', fields),
      },
      latestDepartmentId: current?.fields.departmentId ?? null,
      recordDepartmentId: fields.departmentId,
    };
  },
  approved: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'approve'),
  rejected: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'reject'),
  withdrawn: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'withdraw'),
  resubmitted: () => {
    throw approvalError('CONFLICT', 'APPROVAL_RESUBMIT_VIA_BUSINESS', '任职申请请在申请单上修改后重新提交');
  },
  async edit(tx, ctx, id, input) {
    const { effectiveDate, ...fields } = input;
    const expectedRevision = await businessRevision(tx, ctx.tenantId, id);
    await updateEmploymentBusiness(tx, { ...ctx, expectedRevision }, id, {
      ...(typeof effectiveDate === 'string' ? { effectiveDate } : {}),
      ...(Object.keys(fields).length ? { fields: fields as Partial<PresetFields> } : {}),
    });
  },
};

async function personnelChange(tx: Tx, ctx: ApprovalContext, id: string) {
  const change = await loadChange(tx, { ...ctx, expectedRevision: 0 }, id);
  const subset = String(change.subset) as SubsetKind;
  if (!Object.hasOwn(SUBSETS, subset)) throw new AppError('SERVICE_UNAVAILABLE', '申请子集不存在');
  return { change, subset };
}

const personnelAdapter: BusinessAdapter = {
  async snapshot(tx, ctx, businessId, processCode) {
    const { change, subset } = await personnelChange(tx, ctx, businessId);
    const employeeId = String(change.employeeId);
    const values = change.values as Row;
    const record = change.recordId
      ? await loadSubset(tx, { ...ctx, expectedRevision: 0 }, employeeId, subset, String(change.recordId))
      : null;
    const originals = record ? Object.fromEntries(Object.keys(values).map((key) => [key, record[key] ?? null])) : null;
    const employee = await employeeHeader(tx, ctx.tenantId, employeeId);
    const current = await findCurrentRecord(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
    const departmentId = current?.fields.departmentId ?? null;
    return {
      approvalType: 'personnel_change',
      businessType: 'personnel_change',
      businessId,
      fieldObjectCode: SUBSETS[subset].objectCode,
      subjectEmployeeId: employeeId,
      title: `${employee.name}的${APPROVAL_TYPES.personnel_change.name}申请`,
      values,
      originals,
      changedFields: Object.keys(values).filter((key) => !same(values[key], originals?.[key])),
      conditionValues: {
        processCode,
        'employee.code': employee.code,
        'employee.name': employee.name,
        'employee.departmentId': departmentId,
        'request.subset': subset,
      },
      latestDepartmentId: departmentId,
      recordDepartmentId: departmentId,
    };
  },
  async approved(tx, ctx, id) {
    const { change } = await personnelChange(tx, ctx, id);
    await applyApprovedChangeInTransaction(tx, { ...ctx, expectedRevision: Number(change.revision) }, id);
  },
  // 驳回到发起人：申请保持待审批，可在同一实例上重提或撤回（DEC-053）。
  rejected: async () => undefined,
  async withdrawn(tx, ctx, id) {
    await withdrawChangeInTransaction(tx, { ...ctx, expectedRevision: 0 }, id);
  },
  resubmitted: async () => undefined,
  edit: () => {
    // TODO(需取证 Q-M0-40)：员工子集变更审批节点上的“审批中编辑”字段与落地口径未取证，首版不开放。
    throw approvalError('CONFLICT', 'APPROVAL_EDIT_UNSUPPORTED', '该审批类型暂不支持审批中编辑');
  },
};

export const ADAPTERS: Readonly<Record<BusinessType, BusinessAdapter>> = {
  employment: employmentAdapter,
  personnel_change: personnelAdapter,
};
