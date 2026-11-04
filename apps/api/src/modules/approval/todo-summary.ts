/** 摘要只取审批详情已裁剪的字段；关联名称再经过目标对象的范围和字段权。 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { ApprovalContext } from './context.js';
import { rowsOf } from './context.js';
import { disclosedFields, type DetailData } from './disclosure.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';

export interface TodoForm {
  approvalType: string;
  form: { values: Record<string, unknown> };
}

/** 卡片只消费这些摘要字段，不计算详情动作、历史或编辑表单。字段裁剪仍复用详情的同一入口。 */
export function todoForm(data: DetailData, userId: string, viewable: ReadonlySet<string> | undefined): TodoForm {
  const disclosed = disclosedFields(data, userId, viewable);
  const keys = ['effectiveDate', 'lastWorkDate', 'departmentId', 'typeId'];
  const values = Object.fromEntries(
    keys
      .filter((key) => disclosed.has(key) && Object.hasOwn(data.snapshot.values, key))
      .map((key) => [key, data.snapshot.values[key]]),
  );
  return { approvalType: data.instance.approvalType, form: { values } };
}

export async function todoSummary(tx: Tx, deps: TenantRouteDeps, ctx: ApprovalContext, detail: TodoForm) {
  const values = detail.form.values;
  const summary: { key: string; label: string; value: string }[] = [];
  const add = (key: string, label: string) => {
    const value = values[key];
    if (typeof value === 'string' && value) summary.push({ key, label, value });
  };
  // R1c §2.7～2.9：已取证的日期摘要；其他类型没有业务摘要依据，不臆造表单内容。
  if (['leave', 'retirement'].includes(detail.approvalType)) add('lastWorkDate', '最后工作日');
  else add('effectiveDate', detail.approvalType === 'transfer' ? '调动日期' : '生效日期');
  if (detail.approvalType === 'transfer' && typeof values.departmentId === 'string') {
    const object = MODULE_OBJECTS.organization.code;
    const authorize = authorizeInTransaction(deps.authorize, tx);
    const fields = await getModuleViewableFieldsInTransaction(deps, ctx, object, tx);
    if (
      (await authorize({ tenantId: ctx.tenantId, userId: ctx.userId, action: 'object.view', resource: object })) &&
      (!fields || fields.has('name'))
    ) {
      const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, object, `${object}.list`);
      const [org] = await loadOrgSnapshot(tx, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone), undefined, {
        id: values.departmentId,
        scope,
        includeDisabled: true,
      });
      if (org) summary.push({ key: 'departmentId', label: '调动后任职部门', value: org.name });
    }
  }
  // 合同类型是租户字典，只有审批表单已下发 typeId 时才查名称，不输出原始关联 ID。
  if (detail.approvalType.startsWith('contract_') && typeof values.typeId === 'string') {
    const [type] = rowsOf<{ name: string }>(
      await tx.execute(sql`SELECT name FROM contract_types
      WHERE tenant_id=${ctx.tenantId} AND id=${values.typeId}::uuid`),
    );
    if (type) summary.unshift({ key: 'typeId', label: '合同类型', value: type.name });
  }
  return summary;
}
