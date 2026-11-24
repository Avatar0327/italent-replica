import { sql, type Tx } from '@italent/db';
import {
  EMPLOYEE_READONLY_FIELDS as DOMAIN_READONLY_FIELDS,
  EMPLOYEE_SAME_VALUE_FIELDS,
  TRUSTED_ORIGIN_KINDS,
  isTrustedSavedValue,
  sameAsSavedValue,
  type EmployeeSameValueField,
  type FieldOriginState,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { findPredecessor } from '../employment/read-model.js';
import { loadFieldOrigins } from '../employment/field-origin-store.js';
import { camelRow, rowsOf, snapshotFields } from '../employment/record-store.js';
import type { EmploymentBusinessPatch, EmploymentContext, PresetFields } from '../employment/types.js';
import { requireManagerCandidate } from './employee-managers.js';

// DEC-209：员工发起业务的只读上限，不因入口或额外身份的编辑权放开。单一来源在 domain（C1-2b，DEC-399）。
export const EMPLOYEE_READONLY_FIELDS: ReadonlySet<string> = new Set(DOMAIN_READONLY_FIELDS);

/**
 * 只校验显式输入；原值与服务端自动带出值不能冒充客户端填写，也不按客户端新引用拒绝。
 * `requestFields` 是本次请求里的字段（缺省 = `fields`）：只读上限只问本次输入，沿用的覆盖值不在其中（F-036 §5.2 J1）。
 */
export async function requireEmployeeTransferFields(
  tx: Tx,
  ctx: EmploymentContext,
  effectiveDate: string,
  fields: Partial<PresetFields>,
  employeeId?: string,
  requestFields: object = fields,
) {
  if ([...EMPLOYEE_READONLY_FIELDS].some((field) => Object.hasOwn(requestFields, field)))
    throw new AppError('FORBIDDEN', '员工调动的职务、职级和职务序列只读');
  if (!fields.directManagerId) return;
  let departmentId = fields.departmentId;
  if (departmentId === undefined) {
    if (!employeeId) {
      const [binding] = rowsOf<{ employeeId: string }>(
        await tx.execute(sql`
        SELECT employee_id AS "employeeId" FROM permission_user_person_links
        WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid
      `),
      );
      employeeId = binding?.employeeId;
    }
    if (!employeeId) throw new AppError('FORBIDDEN', '当前用户未绑定员工');
    departmentId = (await findPredecessor(tx, ctx.tenantId, employeeId, effectiveDate))?.fields.departmentId;
  }
  await requireManagerCandidate(tx, ctx, effectiveDate, departmentId ?? undefined, fields.directManagerId);
}

/** 操作人就是这张员工自助单据的本人（与 `fieldOriginEditor` 同口径：此刻的账号绑定）。 */
async function isOwnDraft(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const [link] = rowsOf<{ one: number }>(
    await tx.execute(sql`
      SELECT 1 AS one FROM permission_user_person_links
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND user_id=${ctx.userId}::uuid
    `),
  );
  return link !== undefined;
}

/**
 * DEC-950：员工本人的修改请求里，职位、职务、职级、序列与当前保存值相同的字段不算本次输入。
 * 逐字段比；一个字段同值不替另一个字段放行。比的是保存值本身，不读来源行。
 */
function withoutSameValueFields(saved: PresetFields, patch: EmploymentBusinessPatch): EmploymentBusinessPatch {
  if (!patch.fields) return patch;
  const fields: Record<string, unknown> = { ...patch.fields };
  for (const field of EMPLOYEE_SAME_VALUE_FIELDS)
    if (Object.hasOwn(fields, field) && sameAsSavedValue(saved[field], fields[field])) delete fields[field];
  return { ...patch, fields: fields as Partial<PresetFields> };
}

/** 派生值是否可信取决于它依据的字段本身（F-036 §5.2）。 */
const DERIVATION_SOURCE: Readonly<Record<string, EmployeeSameValueField>> = {
  'post-sequence': 'postId',
  'position-sequence': 'positionId',
};

function trustedSource(states: ReadonlyMap<string, FieldOriginState>, field: EmployeeSameValueField): boolean {
  const state = states.get(`preset:${field}`);
  if (isTrustedSavedValue(state, TRUSTED_ORIGIN_KINDS[field])) return true;
  const writer = state?.lastWriter as { originKind: string; derivationRule?: string | null } | null | undefined;
  if (writer?.originKind !== 'derive' && writer?.originKind !== 'derive-edit') return false;
  const source = DERIVATION_SOURCE[writer.derivationRule ?? ''];
  return source !== undefined && source !== field && trustedSource(states, source);
}

/**
 * J2：保存值本身的来源要可信。只验有来源行的字段（含最后一次写入是显式清空）；从来没有来源行的不复验（§4.8）。
 * 它不受同值放行影响：保存值不可信时，请求带同值也是 403。
 */
async function requireTrustedSavedFields(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const states = await loadFieldOrigins(
    tx,
    ctx,
    businessId,
    EMPLOYEE_SAME_VALUE_FIELDS.map((field) => `preset:${field}`),
  );
  for (const field of EMPLOYEE_SAME_VALUE_FIELDS) {
    const written = states.get(`preset:${field}`)?.lastWriter;
    if (written && !trustedSource(states, field)) throw new AppError('FORBIDDEN', '员工调动的职务、职级和职务序列只读');
  }
}

/**
 * 已保存单据以可信来源元数据识别员工业务；修改/提交及其重放都必须调用，不能只保护新建路由。
 * 返回扣掉同值字段之后的“本次输入”（F-036 §5.2、DEC-950）：调用方其后凡是问“本次输入了什么”的校验都用它。
 * 单据不是员工自助单据时原样返回。
 */
export async function requireEmployeeTransferBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  patch?: EmploymentBusinessPatch,
): Promise<EmploymentBusinessPatch | undefined> {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.* FROM transfer_requests tr
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=tr.tenant_id AND p.business_id=tr.business_id
      ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE tr.tenant_id=${ctx.tenantId} AND tr.business_id=${businessId}::uuid AND tr.initiator='employee'
  `),
  );
  if (!row) return patch;
  const payload = camelRow(row);
  const saved = snapshotFields(payload);
  const codes = payload.explicitFieldCodes as string[];
  const explicit: Partial<PresetFields> = Object.fromEntries(
    codes
      .filter((code) => code.startsWith('preset:'))
      .map((code) => {
        const key = code.slice(7) as keyof PresetFields;
        return [key, saved[key]];
      }),
  );
  // 与 normalizePatchedInput 一致：换部门且未手填经理时，旧手填经理被新部门负责人替代。
  if (patch?.fields && Object.hasOwn(patch.fields, 'departmentId') && !Object.hasOwn(patch.fields, 'directManagerId'))
    delete (explicit as Record<string, unknown>).directManagerId;
  // J1：先定本次输入。只有单据本人才有同值放行；HR、审批人改这张单据照旧出现键即判。
  const current =
    patch && (await isOwnDraft(tx, ctx, payload.employeeId as string)) ? withoutSameValueFields(saved, patch) : patch;
  await requireEmployeeTransferFields(
    tx,
    ctx,
    current?.effectiveDate ?? (payload.effectiveDate as string),
    { ...explicit, departmentId: saved.departmentId, ...current?.fields },
    payload.employeeId as string,
    current?.fields ?? {},
  );
  await requireTrustedSavedFields(tx, ctx, businessId);
  return current;
}
