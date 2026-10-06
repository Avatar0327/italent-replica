import { linkageApproval } from '../transfer/linkage/approval.js';
import type { ForeignField } from './foreign-fields.js';
import { plannedEffectiveDate } from '../employment/timeline.js';
import { lockTransferBusiness } from '../employment/transfer-locks.js';
/**
 * 业务适配：把任职申请、人员自助变更申请转换为审批快照（表单值、变更前原值、变化字段、条件取值、路由部门），
 * 并在审批结束时调用各模块已有的可信端口（任职状态机 / 申请落地），与审批写入同事务。
 */
import { lockEstablishment } from '../establishment/store.js';
import { contractAdapter } from '../contracts/adapter.js';
import { sql, type Tx } from '@italent/db';
import {
  ageOn,
  APPROVAL_TYPES,
  approvalTypeOfBusiness,
  PROFILE_FORM_FIELDS,
  SUBSETS,
  subsetProcessCode,
  tenantLocalDate,
  type ApprovalTypeCode,
  type SubsetKind,
} from '@italent/domain';
import { findCurrentRecord, findPredecessor, loadEmploymentBusiness } from '../employment/read-model.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import { transitionEmployment } from '../employment/transitions.js';
import { PRESET_FIELD_NAMES, type PresetFields } from '../employment/types.js';
import { updateEmploymentBusiness } from '../employment/write-service.js';
import { resolveTransferForm } from '../transfer/configuration.js';
import {
  applyApprovedChangeInTransaction,
  disapproveChangeInTransaction,
  currentChangeValues,
  loadChange,
  resubmitChangeInTransaction,
  withdrawChangeInTransaction,
} from '../personnel/change-requests.js';
import { lockPerson } from '../personnel/store.js';
import { loadSubset } from '../personnel/subsets.js';
import { AppError } from '../../errors.js';
import { approvalError, rowsOf, type ApprovalContext, type Row } from './context.js';

export type BusinessType = 'employment' | 'personnel_change' | 'contract';

export interface BusinessSnapshot {
  readonly approvalType: ApprovalTypeCode;
  readonly businessType: BusinessType;
  readonly businessId: string;
  /** 字段权限所在对象：最小披露与盲审都按该对象的可查看字段判断（DEC-057 / DEC-058）。 */
  readonly fieldObjectCode: string;
  /** 表单带出的员工档案只读字段（DEC-122 性别、年龄）：值在 values 中，按员工信息对象的字段查看权裁剪。 */
  readonly profileFields: readonly string[];
  readonly subjectEmployeeId: string | null;
  readonly title: string;
  readonly values: Readonly<Row>;
  readonly originals: Readonly<Row> | null;
  readonly changedFields: readonly string[];
  /** 嵌套的其他对象字段（R1-T10 合同变更）：披露与盲审按所属对象的权限判断（foreign-fields.ts）。 */
  readonly foreignFields?: readonly ForeignField[];
  readonly conditionValues: Readonly<Row>;
  readonly latestDepartmentId: string | null;
  readonly recordDepartmentId: string | null;
  /** 业务载荷版本：实例记下审批人所读的版本，绕过审批改了业务单即判旧审批失效（AGENTS §10「并发」）。 */
  readonly version: string;
  /**
   * 流程编码由服务端按业务与发起入口派生，不由发起人指定（PR #35 第二轮清单 14），取原站标准编码（`14` §11.1）：
   * 调动取创建时冻结的入口编码（如 Customized{n}TransferFlow），其他任职业务取审批类型的标准编码，
   * 员工子集变更按子集取各自的编码。客户端提交参数不能覆盖这份绑定。
   */
  readonly processCode: string | null;
}

export interface BusinessAdapter {
  /** 按业务侧既有顺序加锁（员工 → 业务单），审批命令随后再锁实例，与业务入口的锁序一致（清单 11）。 */
  lock(tx: Tx, ctx: ApprovalContext, businessId: string, sourceOnly?: boolean): Promise<void>;
  snapshot(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<BusinessSnapshot>;
  approved(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  rejected(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  /** 沿「不同意」连线流转到结束（DEC-144）：业务单办结为“未通过”、不生效，不能修改重提。 */
  disapproved(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  /** 审批侧发起的撤回（业务侧撤回已由业务模块自己迁移状态）。 */
  withdrawn(tx: Tx, ctx: ApprovalContext, businessId: string): Promise<void>;
  /**
   * 审批侧发起的同单重提（DEC-099 / DEC-103）：业务单回到待审批，修正追加为业务侧新版本，并按首次提交复核当前权限
   * （第四轮 N1）。任职申请经任职模块的“提交”重提，这里拒绝。
   */
  resubmit(tx: Tx, ctx: ApprovalContext, businessId: string, corrections: Readonly<Row>): Promise<void>;
  edit(tx: Tx, ctx: ApprovalContext, businessId: string, fields: Readonly<Row>): Promise<void>;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * DEC-122：调动审批详情带出员工档案的性别与年龄（年龄按租户业务日期由出生日期计算，与员工档案一致）。
 * 只读带出，不进入变化字段与盲审；可见性按员工信息对象的字段查看权另行裁剪（routes.detailViewable）。
 */
async function profileValues(tx: Tx, ctx: ApprovalContext, employeeId: string): Promise<Row> {
  const [profile] = rowsOf<{ gender: string | null; birthday: string | null }>(
    await tx.execute(sql`SELECT gender,birthday::text FROM personnel_employee_versions
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
  );
  return {
    gender: profile?.gender ?? null,
    age: ageOn(profile?.birthday ?? null, tenantLocalDate(ctx.now, ctx.timezone)),
  };
}

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
  action: 'approve' | 'reject' | 'disapprove' | 'withdraw',
) {
  const expectedRevision = await businessRevision(tx, ctx.tenantId, id);
  await transitionEmployment(tx, { ...ctx, expectedRevision }, { id, action });
}

async function latestPayload(tx: Tx, tenantId: string, businessId: string) {
  // DEC-218：后台序列同步不改实例。并发令牌仅越过同事务 outbox 证明的序列同步版本，
  // 普通更正仍使用新的载荷编号、使旧审批409；表单值仍由 loadEmploymentBusiness 读取最新载荷。
  const [row] = rowsOf<{ id: string; last_work_date: string | null }>(
    await tx.execute(sql`WITH RECURSIVE versions AS (
      (SELECT p.* FROM employment_payload_versions p WHERE tenant_id=${tenantId}
        AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1)
      UNION ALL
      SELECT previous.* FROM versions current
      JOIN employment_payload_versions previous ON previous.tenant_id=current.tenant_id
        AND previous.business_id=current.business_id AND previous.id=current.previous_version_id
        AND previous.version_no<current.version_no
      WHERE EXISTS (SELECT 1 FROM employment_outbox o WHERE o.tenant_id=current.tenant_id
        AND o.business_id=current.business_id AND o.payload_version_id=current.id
        AND o.event_type='employment.sequence-sync' AND o.command_id=current.command_id)
    ) SELECT id,last_work_date::text FROM versions ORDER BY version_no LIMIT 1`),
  );
  if (!row) throw new AppError('SERVICE_UNAVAILABLE', '任职业务版本链不完整');
  return { version: row.id, lastWorkDate: row.last_work_date ?? null };
}

/** 13 §6.3：类型字典与入口不是一一对应；以可信入口绑定匹配，不从类型序号拼接编码。 */
async function transferProcessCode(tx: Tx, tenantId: string, businessId: string, formId: string) {
  const [entry] = rowsOf<{ processCode: string }>(
    await tx.execute(sql`SELECT process_code AS "processCode" FROM transfer_requests
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`),
  );
  // 已存业务保留创建时的绑定；旧任职业务没有入口元数据时，按它的服务端表单定义解析。
  return entry?.processCode ?? (await resolveTransferForm(tx, tenantId, formId)).processCode;
}

async function transferMetadata(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<{ transferTypeCode: string; reasonCode: string | null; withEstablishment: boolean }>(
    await tx.execute(sql`
    SELECT transfer_type_code AS "transferTypeCode",reason_code AS "reasonCode",
      with_establishment AS "withEstablishment" FROM transfer_requests
    WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
  `),
  );
  return row ?? {};
}

/** 自定义字段以权限字段编码 `custom:<id>` 出现在审批载荷里，与任职字段权限一致。 */
const customValues = (values: Readonly<Record<string, unknown>> | undefined): Row =>
  Object.fromEntries(Object.entries(values ?? {}).map(([id, value]) => [`custom:${id}`, value]));

/**
 * 审批字段 → 任职业务修改：任职预置字段进 fields，`custom:<id>` 进 customFields，业务日期与最后工作日写顶层
 * （最后工作日变化时由任职模块重算生效日并校验日期关系）。
 */
function employmentPatch(input: Readonly<Row>) {
  const fields: Row = {};
  const customFields: Row = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'effectiveDate' || key === 'lastWorkDate') continue;
    if (key.startsWith('custom:')) customFields[key.slice('custom:'.length)] = value;
    else fields[key] = value;
  }
  return {
    ...(typeof input.effectiveDate === 'string' ? { effectiveDate: input.effectiveDate } : {}),
    ...(Object.hasOwn(input, 'lastWorkDate') ? { lastWorkDate: input.lastWorkDate as string | null } : {}),
    ...(Object.keys(fields).length ? { fields: fields as Partial<PresetFields> } : {}),
    ...(Object.keys(customFields).length ? { customFields: customFields as Record<string, never> } : {}),
  };
}

/** 流程发起条件里的任职引用（调动前 / 本单）。 */
const ref = (prefix: 'before' | 'record', source: Partial<PresetFields> | undefined) =>
  Object.fromEntries(
    (['departmentId', 'postId', 'positionId', 'levelId'] as const).map((key) => [
      `${prefix}.${key}`,
      source?.[key] ?? null,
    ]),
  );

async function completedTransferDates(
  tx: Tx,
  ctx: ApprovalContext,
  business: NonNullable<Awaited<ReturnType<typeof loadEmploymentBusiness>>>,
): Promise<Row> {
  if (business.kind !== 'transfer' || business.status !== 'effective') return {};
  const planned = plannedEffectiveDate(ctx.tenantId, sql`${business.id}::uuid`, sql`${business.effectiveDate}::date`);
  const [dates] = rowsOf<Row>(await tx.execute(sql`SELECT ${planned}::text AS "originalEffectiveDate"`));
  return { ...dates, actualEffectiveDate: business.effectiveDate };
}

const employmentAdapter: BusinessAdapter = {
  async lock(tx, ctx, businessId) {
    const [owner] = rowsOf<{ employee_id: string; kind: string }>(
      await tx.execute(sql`SELECT employee_id, (SELECT kind FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) AS kind
        FROM employment_business_objects b WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
    );
    if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
    await lockTransferBusiness(tx, ctx, businessId);
    await lockEmploymentEmployee(tx, ctx, owner.employee_id);
    await tx.execute(sql`SELECT 1 FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid FOR UPDATE`);
    // org/locks.ts：员工 / 业务 → 组织 → 编制 → 实例；审批推进时只重入资源锁。
    if (owner.kind === 'transfer') await lockEstablishment(tx, ctx, { initializeDefault: false });
  },
  async snapshot(tx, ctx, businessId) {
    const asOf = tenantLocalDate(ctx.now, ctx.timezone);
    const business = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, asOf);
    if (!business) throw new AppError('NOT_FOUND', '任职业务不存在');
    const approvalType = approvalTypeOfBusiness(business.kind);
    if (!approvalType) throw approvalError('CONFLICT', 'APPROVAL_TYPE_UNKNOWN', '该业务没有审批类型');
    const type = APPROVAL_TYPES[approvalType];
    const processCode =
      business.kind === 'transfer'
        ? await transferProcessCode(tx, ctx.tenantId, businessId, business.formId)
        : type.defaultProcessCode;
    const before = await findPredecessor(tx, ctx.tenantId, business.employeeId, business.effectiveDate);
    const current = await findCurrentRecord(tx, ctx.tenantId, business.employeeId, asOf);
    const employee = await employeeHeader(tx, ctx.tenantId, business.employeeId);
    // 人员类型（employType）由任职周期派生、申请载荷不携带（write-service effectiveEmployType），不算本单变化。
    const employType = business.kind === 'intern_regularization' ? 'internal' : before?.fields.employType;
    const fields: PresetFields = { ...business.fields, employType: business.fields.employType ?? employType ?? null };
    const payload = await latestPayload(tx, ctx.tenantId, businessId);
    const linkage = await linkageApproval(tx, ctx.tenantId, businessId, business.kind); // R1-T10 P1-6
    // 清单 3：载荷、原值与变化检测覆盖预置字段、自定义字段、业务日期与最后工作日。
    const originals: Row | null = before
      ? {
          ...before.fields,
          ...customValues(before.customFields),
          effectiveDate: before.effectiveDate,
          lastWorkDate: null,
        }
      : null;
    const values: Row = {
      ...fields,
      ...(business.kind === 'transfer' ? await transferMetadata(tx, ctx.tenantId, businessId) : {}),
      ...linkage.values,
      ...customValues(business.customFields),
      effectiveDate: business.effectiveDate,
      ...(await completedTransferDates(tx, ctx, business)),
      lastWorkDate: payload.lastWorkDate,
      kind: business.kind,
      mode: business.mode,
      ...(await profileValues(tx, ctx, business.employeeId)),
    };
    const customCodes = new Set([
      ...Object.keys(customValues(business.customFields)),
      ...Object.keys(customValues(before?.customFields)),
    ]);
    const changedFields = [
      ...PRESET_FIELD_NAMES.filter((field) => !same(fields[field], originals?.[field])),
      ...[...customCodes].filter((code) => !same(values[code], originals?.[code])),
      // 业务日期是本单新内容，审批人必须看得到；最后工作日只在离职 / 退休单上出现。
      'effectiveDate',
      ...(payload.lastWorkDate ? ['lastWorkDate'] : []),
      ...(values.withEstablishment === true ? ['withEstablishment'] : []),
      ...linkage.changedFields,
    ];
    return {
      approvalType,
      businessType: 'employment',
      businessId,
      fieldObjectCode: type.objectCode,
      profileFields: PROFILE_FORM_FIELDS,
      subjectEmployeeId: business.employeeId,
      // 清单 8：标题不含个人数据（DEC-057），待办与列表原样展示也不泄露被隐藏的姓名。
      title: `${type.name}申请`,
      values,
      originals,
      changedFields,
      conditionValues: {
        processCode,
        'business.kind': business.kind,
        'employee.code': employee.code,
        'employee.name': employee.name,
        'record.effectiveDate': business.effectiveDate,
        ...ref('before', before?.fields),
        ...ref('record', fields),
      },
      latestDepartmentId: current?.fields.departmentId ?? null,
      recordDepartmentId: fields.departmentId,
      ...(linkage.foreignFields.length ? { foreignFields: linkage.foreignFields } : {}),
      version: linkage.version ? `${payload.version}:${linkage.version}` : payload.version,
      processCode,
    };
  },
  approved: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'approve'),
  rejected: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'reject'),
  disapproved: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'disapprove'),
  withdrawn: (tx, ctx, id) => employmentTransition(tx, ctx, id, 'withdraw'),
  resubmit: () => {
    throw approvalError('CONFLICT', 'APPROVAL_RESUBMIT_VIA_BUSINESS', '任职申请请在申请单上修改后重新提交');
  },
  async edit(tx, ctx, id, input) {
    const expectedRevision = await businessRevision(tx, ctx.tenantId, id);
    await updateEmploymentBusiness(tx, { ...ctx, expectedRevision }, id, employmentPatch(input), {
      approvalEdit: true,
    });
  },
};

async function personnelChange(tx: Tx, ctx: ApprovalContext, id: string) {
  const change = await loadChange(tx, { ...ctx, expectedRevision: 0 }, id);
  const subset = String(change.subset) as SubsetKind;
  if (!Object.hasOwn(SUBSETS, subset)) throw new AppError('SERVICE_UNAVAILABLE', '申请子集不存在');
  return { change, subset };
}

/** 子集历史版本（含已删除记录的版本链），按记录 ID 与 revision 定位。 */
async function subsetVersion(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  subset: SubsetKind,
  recordId: string,
  revision: number,
): Promise<Row | null> {
  const [raw] = rowsOf<Row>(
    await tx.execute(sql`SELECT * FROM ${sql.identifier(`${SUBSETS[subset].table}_versions`)}
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid
        AND revision=${revision} LIMIT 1`),
  );
  return raw ? camelRow(raw) : null;
}

const camelRow = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]),
  );

const personnelAdapter: BusinessAdapter = {
  async lock(tx, ctx, businessId) {
    const { change } = await personnelChange(tx, ctx, businessId);
    await lockPerson(tx, { ...ctx, expectedRevision: 0 }, String(change.employeeId));
  },
  async snapshot(tx, ctx, businessId) {
    const { change, subset } = await personnelChange(tx, ctx, businessId);
    const employeeId = String(change.employeeId);
    const values = await currentChangeValues(tx, { ...ctx, expectedRevision: 0 }, businessId);
    // 清单 9：原值取申请所针对的那一版（targetRevision），不随审批落地或源记录删除而漂移 / 失败。
    const record = change.recordId
      ? await subsetVersion(
          tx,
          ctx.tenantId,
          employeeId,
          subset,
          String(change.recordId),
          Number(change.targetRevision),
        )
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
      profileFields: [],
      subjectEmployeeId: employeeId,
      title: `${APPROVAL_TYPES.personnel_change.name}申请`,
      values,
      originals,
      changedFields: Object.keys(values).filter((key) => !same(values[key], originals?.[key])),
      conditionValues: {
        processCode: subsetProcessCode(subset),
        'employee.code': employee.code,
        'employee.name': employee.name,
        'employee.departmentId': departmentId,
        'request.subset': subset,
      },
      latestDepartmentId: departmentId,
      recordDepartmentId: departmentId,
      version: `revision:${Number(change.revision)}`,
      processCode: subsetProcessCode(subset),
    };
  },
  async approved(tx, ctx, id) {
    const { change, subset } = await personnelChange(tx, ctx, id);
    if (change.recordId) {
      const live = await loadSubset(
        tx,
        { ...ctx, expectedRevision: 0 },
        String(change.employeeId),
        subset,
        String(change.recordId),
        true,
      ).catch(() => null);
      if (!live || live.deleted || Number(live.revision) !== Number(change.targetRevision)) {
        throw approvalError('CONFLICT', 'APPROVAL_BUSINESS_CONFLICT', '申请针对的记录已被修改或删除，请撤回后重新申请');
      }
    }
    await applyApprovedChangeInTransaction(tx, { ...ctx, expectedRevision: Number(change.revision) }, id);
  },
  // 驳回到发起人：申请保持待审批，可在同一实例上重提或撤回（DEC-053）。
  rejected: async () => undefined,
  async disapproved(tx, ctx, id) {
    await disapproveChangeInTransaction(tx, { ...ctx, expectedRevision: 0 }, id);
  },
  async withdrawn(tx, ctx, id) {
    await withdrawChangeInTransaction(tx, { ...ctx, expectedRevision: 0 }, id);
  },
  async resubmit(tx, ctx, id, corrections) {
    await resubmitChangeInTransaction(tx, { ...ctx, expectedRevision: 0 }, id, corrections);
  },
  edit: () => {
    // DEC-105：首版不做员工子集变更的审批中编辑（有意差异，原站可绑定，`14` §11.3）；要改内容时驳回，
    // 由申请人在同一张单上修正重提（DEC-099）。
    throw approvalError('CONFLICT', 'APPROVAL_EDIT_UNSUPPORTED', '员工子集变更不支持审批中编辑，请驳回后由申请人修正');
  },
};

export const ADAPTERS: Readonly<Record<BusinessType, BusinessAdapter>> = {
  contract: contractAdapter,
  employment: employmentAdapter,
  personnel_change: personnelAdapter,
};
