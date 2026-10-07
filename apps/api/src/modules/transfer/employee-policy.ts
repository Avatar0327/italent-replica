import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { findPredecessor } from '../employment/read-model.js';
import { camelRow, rowsOf, snapshotFields } from '../employment/record-store.js';
import type { EmploymentBusinessPatch, EmploymentContext, PresetFields } from '../employment/types.js';
import { loadJobObject } from '../job/read-model.js';
import { requireManagerCandidate } from './employee-managers.js';

// DEC-209：员工发起业务的只读上限，不因入口或额外身份的编辑权放开。
export const EMPLOYEE_READONLY_FIELDS = new Set(['postId', 'levelId', 'sequenceId', 'positionId']);

/** 只校验显式输入；原值与服务端自动带出值不能冒充客户端填写，也不按客户端新引用拒绝。 */
export async function requireEmployeeTransferFields(
  tx: Tx,
  ctx: EmploymentContext,
  effectiveDate: string,
  fields: Partial<PresetFields>,
  employeeId?: string,
) {
  if ([...EMPLOYEE_READONLY_FIELDS].some((field) => Object.hasOwn(fields, field)))
    throw new AppError('FORBIDDEN', '员工调动的职位、职务、职级和职务序列不可编辑');
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
  // DEC-209/232：explicitFieldCodes 还记录 HR 编辑与向后传播，不能当作本次客户端输入。
  // 旧显式草稿也属于已保存值；本次员工写入仍按请求体拒绝，提交/重放继续复验当前范围。
  // DEC-209 既有升级防线：未经过本人只读上限、也没有系统传播来源的旧职务/职级/序列草稿不能重提。
  // DEC-232 的旧职位兼容单独处理；可信本人快照及传播版本的显式代码不代表员工输入。
  if (
    !(payload.formSnapshot as { employeeTransfer?: boolean }).employeeTransfer &&
    !payload.triggerBusinessId &&
    codes.some((code) => ['preset:postId', 'preset:levelId', 'preset:sequenceId'].includes(code))
  )
    throw new AppError('FORBIDDEN', '旧员工调动草稿包含不可编辑的任职字段');
  if (patch?.fields && Object.hasOwn(patch.fields, 'positionId')) {
    const [binding] = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`
      SELECT employee_id AS "employeeId" FROM permission_user_person_links
      WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid
    `),
    );
    if (binding?.employeeId === payload.employeeId) throw new AppError('FORBIDDEN', '员工调动的职位不可编辑');
  }
  const checkedPatch = { ...patch?.fields };
  delete checkedPatch.positionId;
  await requireEmployeeTransferFields(
    tx,
    ctx,
    patch?.effectiveDate ?? (payload.effectiveDate as string),
    { departmentId: saved.departmentId, ...checkedPatch },
    payload.employeeId as string,
  );
  // 旧手填经理仍按当前候选范围复验；换部门或显式改/清空经理后由本次输入与部门联动负责。
  if (
    codes.includes('preset:directManagerId') &&
    saved.directManagerId &&
    !Object.hasOwn(patch?.fields ?? {}, 'departmentId') &&
    !Object.hasOwn(patch?.fields ?? {}, 'directManagerId')
  )
    await requireManagerCandidate(
      tx,
      ctx,
      patch?.effectiveDate ?? (payload.effectiveDate as string),
      saved.departmentId ?? undefined,
      saved.directManagerId,
    );
}

/** DEC-232：只处理可信继承职位；HR 显式补充仍交由原有任职引用校验，不自动替换或清空。 */
export async function employeeTransferPosition(
  tx: Tx,
  ctx: EmploymentContext,
  effectiveDate: string,
  fields: PresetFields,
): Promise<PresetFields> {
  if (!fields.positionId) return fields;
  const position = await loadJobObject(tx, ctx.tenantId, 'positions', fields.positionId, effectiveDate, true);
  // 生效日没有职位版本时无法判断所属部门，保留既有值交由引用校验拒绝失效引用，不以清空掩盖错误。
  return position && position.orgId !== fields.departmentId ? { ...fields, positionId: null } : fields;
}

/** 老申请的冻结快照没有 DEC-232 标记时，以服务器保存的入口来源判断，不信任客户端。 */
export async function isEmployeeTransferPayload(tx: Tx, tenantId: string, prepared: object) {
  // 编制投影也解析其他任职业务；非调动不需要逐行查询入口来源。
  if (
    !('kind' in prepared) ||
    prepared.kind !== 'transfer' ||
    !('businessId' in prepared) ||
    typeof prepared.businessId !== 'string'
  )
    return false;
  const [request] = rowsOf(
    await tx.execute(sql`
    SELECT 1 FROM transfer_requests WHERE tenant_id=${tenantId}
      AND business_id=${prepared.businessId}::uuid AND initiator='employee'
  `),
  );
  return !!request;
}
