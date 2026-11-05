/** DEC-790：本人申请的对象归属、专属字段投影和 PT-R3；不扩展共享本人档案权限。 */
import { withTenant, type Tx } from '@italent/db';
import {
  SELF_APPLICATION_BUTTONS,
  SELF_APPLICATION_OBJECTS,
  buttonResource,
  tenantLocalDate,
  type SelfApplicationKind,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { requirePermission } from '../../authorization.js';
import { EMPLOYMENT_OBJECT, requireEmploymentWrite } from '../employment/context.js';
import { loadExitRequest, withAckWarnings } from '../employment/exit-gate.js';
import { loadExitDetail } from '../employment/exit-queries.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import { loadPartTimeRequest } from '../employment/part-time/request-store.js';
import { requestDto } from '../employment/part-time/request-read.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { getModuleViewableFieldsInTransaction, authorizeInTransaction } from '../permission/module-access.js';
import type { SelfAccess } from './access.js';
import { visibleFields } from './field-disclosure.js';

export const ownRequestMissing = () => new AppError('NOT_FOUND', '申请不存在');
export async function ownRequest(tx: Tx, self: SelfAccess, kind: SelfApplicationKind, id: string) {
  await self.check(tx);
  if (kind === 'partTime') {
    const row = await loadPartTimeRequest(tx, self.ctx.tenantId, id);
    if (
      !row ||
      row.employeeId !== self.employee.id ||
      row.initiatorUserId !== self.ctx.userId ||
      row.initiator !== 'self' ||
      row.requestType !== 'add'
    )
      throw ownRequestMissing();
    return { ...requestDto(row) };
  }
  const row = await loadExitRequest(tx, self.ctx.tenantId, id);
  if (
    !row ||
    row.employeeId !== self.employee.id ||
    row.initiatorUserId !== self.ctx.userId ||
    row.initiator !== 'self'
  )
    throw ownRequestMissing();
  const business = await loadEmploymentBusiness(
    tx,
    self.ctx.tenantId,
    id,
    tenantLocalDate(self.ctx.now, self.ctx.timezone),
    self.ctx.scope,
  );
  const detail = await loadExitDetail(tx, self.ctx.tenantId, id, self.ctx.scope);
  if (!business || !detail) throw ownRequestMissing();
  return withAckWarnings(tx, self.ctx, {
    ...business,
    lastWorkDate: detail.lastWorkDate,
    reasonCode: row.reasonCode,
    whereaboutsCode: row.whereaboutsCode,
  });
}

/** PT-R3 / DEC-790：本租户启用部门，不裁员工数据范围；根节点只作导航。读候选和写复核共用。 */
export async function selfPartTimeDepartmentScope(tx: Tx, self: SelfAccess, date: string, id?: string) {
  await self.check(tx);
  const rows = await loadOrgSnapshot(tx, self.ctx.tenantId, date, undefined, {
    includeDisabled: false,
    ...(id ? { id } : {}),
  });
  const items = rows.map((row) => ({
    id: row.id,
    name: row.fullName || row.name,
    parentId: row.parents.admin?.parentId ?? null,
    selectable: row.id !== self.ctx.tenantId,
  }));
  if (id && !items.some((row) => row.id === id && row.selectable))
    throw new AppError('VALIDATION_FAILED', '请选择本租户启用的非根部门');
  return items;
}

export async function requireApplicationAccess(
  tx: Tx,
  self: SelfAccess,
  kind: SelfApplicationKind,
  operation?: 'create' | 'update',
  payload: object = {},
) {
  await self.check(tx);
  const authorize = authorizeInTransaction(self.deps.authorize, tx);
  await requirePermission(authorize, {
    ...self.ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, SELF_APPLICATION_BUTTONS[kind], 'detail'),
  });
  if (operation)
    await requireEmploymentWrite({ ...self.ctx, authorize }, operation, payload, undefined, undefined, {
      commandOnly: !Object.keys(payload).length,
    });
}

const protocol = ['id', 'employeeId', 'employeeRevision', 'revision', 'status', 'kind'];
/** 固定协议字段 + 当前专属查看权；别把 HR 扩展、附件和自定义字段带回本人入口。 */
export async function projectApplication(self: SelfAccess, body: unknown) {
  return withTenant(self.deps.db, self.ctx.tenantId, async (tx) => {
    await self.check(tx);
    const visible =
      (await getModuleViewableFieldsInTransaction(self.deps, self.ctx, EMPLOYMENT_OBJECT, tx)) ?? new Set<string>();
    const source = body as Record<string, unknown>;
    const result = visibleFields(source, new Set([...protocol, ...visible]));
    delete result.customFields;
    delete result.attachmentRefs;
    if (Array.isArray(source.warnings))
      result.warnings = source.warnings.map((warning: object | string) =>
        typeof warning === 'string' ? { reason: warning } : visibleFields(warning, new Set(['reason', 'limit'])),
      );
    if (visible.has('partTimeType') && 'serviceType' in source) result.serviceType = source.serviceType;
    result.fields = visibleFields((source.fields ?? {}) as object, visible);
    return result;
  });
}

export async function applicationForm(tx: Tx, self: SelfAccess, kind: SelfApplicationKind) {
  await requireApplicationAccess(tx, self, kind);
  const authorize = authorizeInTransaction(self.deps.authorize, tx);
  const visible = await getModuleViewableFieldsInTransaction(self.deps, self.ctx, EMPLOYMENT_OBJECT, tx);
  const allowed = (action: 'object.create' | 'object.update', fields: string[]) =>
    authorize({ ...self.ctx, action, resource: EMPLOYMENT_OBJECT, fields });
  const fieldModes: Record<string, string> = {};
  for (const { code } of SELF_APPLICATION_OBJECTS[kind].fields)
    if (visible?.has(code)) fieldModes[code] = (await allowed('object.create', [code])) ? 'editable' : 'readonly';
  return {
    employee: self.employee,
    dataOperations: { create: await allowed('object.create', []), update: await allowed('object.update', []) },
    fieldModes,
    values: kind === 'exit' && visible?.has('reasonCode') ? { reasonCode: 'personal' } : {},
  };
}
