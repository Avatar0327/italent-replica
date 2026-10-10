import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_READONLY_FIELDS as DOMAIN_READONLY_FIELDS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { findPredecessor } from '../employment/read-model.js';
import { camelRow, rowsOf, snapshotFields } from '../employment/record-store.js';
import type { EmploymentBusinessPatch, EmploymentContext, PresetFields } from '../employment/types.js';
import { requireManagerCandidate } from './employee-managers.js';

// DEC-209：员工发起业务的只读上限，不因入口或额外身份的编辑权放开。单一来源在 domain（C1-2b，DEC-399）。
export const EMPLOYEE_READONLY_FIELDS: ReadonlySet<string> = new Set(DOMAIN_READONLY_FIELDS);

/** 只校验显式输入；原值与服务端自动带出值不能冒充客户端填写，也不按客户端新引用拒绝。 */
export async function requireEmployeeTransferFields(
  tx: Tx,
  ctx: EmploymentContext,
  effectiveDate: string,
  fields: Partial<PresetFields>,
  employeeId?: string,
) {
  if ([...EMPLOYEE_READONLY_FIELDS].some((field) => Object.hasOwn(fields, field)))
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

/** 已保存单据以可信来源元数据识别员工业务；修改/提交及其重放都必须调用，不能只保护新建路由。 */
export async function requireEmployeeTransferBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  patch?: EmploymentBusinessPatch,
) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.* FROM transfer_requests tr
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=tr.tenant_id AND p.business_id=tr.business_id
      ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE tr.tenant_id=${ctx.tenantId} AND tr.business_id=${businessId}::uuid AND tr.initiator='employee'
  `),
  );
  if (!row) return;
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
  await requireEmployeeTransferFields(
    tx,
    ctx,
    patch?.effectiveDate ?? (payload.effectiveDate as string),
    { ...explicit, departmentId: saved.departmentId, ...patch?.fields },
    payload.employeeId as string,
  );
}
