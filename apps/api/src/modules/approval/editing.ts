/** DEC-233：只披露本人的有效节点编辑能力，不返回流程配置或其他审批人的编辑设置。 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, blindReviewFields, hasExit, type EditMode } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { ApprovalContext } from './context.js';
import { rowsOf } from './context.js';
import { disclosedFields, type DetailData } from './disclosure.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { PRESET_FIELD_NAMES } from '../employment/types.js';
import { addSignLink, isOwnRequest } from './rules.js';

export interface NodeEditing {
  readonly editMode: EditMode;
  readonly editableFields: readonly string[];
}

export const NO_NODE_EDITING: NodeEditing = { editMode: 'none', editableFields: [] };

/** 沿用 employmentPatch 的受支持载荷字段与已冻结的业务表单策略；不把只读抬头/联动区块当作可写字段。 */
async function employmentEditingFields(tx: Tx, ctx: ApprovalContext, data: DetailData) {
  if (data.instance.businessType !== 'employment') return new Set<string>();
  const [payload] = rowsOf<{
    kind: string;
    mode: string;
    state: string;
    form_snapshot: { readonly fieldModes?: Readonly<Record<string, string>> };
  }>(
    await tx.execute(sql`SELECT p.kind,p.mode,p.form_snapshot,s.state
    FROM employment_business_objects b
    JOIN LATERAL (SELECT kind,mode,form_snapshot FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.id=${data.instance.businessId}::uuid`),
  );
  if (!payload || payload.mode !== 'application' || payload.state !== 'in_review') return new Set<string>();
  const modes = payload.form_snapshot.fieldModes ?? {};
  const fields = PRESET_FIELD_NAMES.filter(
    (field) =>
      (field !== 'employType' || data.snapshot.approvalType === 'hire') &&
      (payload.kind !== 'transfer' || modes[`preset:${field}`] === 'editable'),
  );
  return new Set<string>([
    ...fields,
    'effectiveDate',
    ...(['leave', 'retirement'].includes(payload.kind) ? ['lastWorkDate'] : []),
    ...Object.keys(data.snapshot.values).filter((field) => field.startsWith('custom:') && modes[field] === 'editable'),
  ]);
}

export async function readNodeEditing(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: ApprovalContext,
  data: DetailData,
  viewable: ReadonlySet<string> | undefined,
): Promise<NodeEditing> {
  const { instance, snapshot, allTasks, version } = data;
  const mine = allTasks.find((task) => task.status === 'pending' && task.assigneeUserId === ctx.userId);
  const node = version.nodes.find((candidate) => candidate.key === mine?.nodeKey);
  const type = APPROVAL_TYPES[snapshot.approvalType];
  if (
    instance.status !== 'running' ||
    !mine ||
    !node ||
    !type.approvalEdit ||
    node.editMode === 'none' ||
    addSignLink(allTasks, mine) ||
    isOwnRequest(instance, data.subjectUserId, ctx.userId) ||
    blindReviewFields(snapshot.changedFields, viewable).length ||
    snapshot.version !== instance.businessVersion ||
    (node.editMode === 'with_approve' && !hasExit(node, 'approve'))
  )
    return NO_NODE_EDITING;
  // DEC-242：节点编辑与既有 edit 写入口一致，按本人任务与当前字段权限判断，不另加业务数据范围。
  const supported = await employmentEditingFields(tx, ctx, data);
  const disclosed = disclosedFields(data, ctx.userId, viewable);
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const editableFields: string[] = [];
  const readonlyFields: readonly string[] = type.readonlyFields;
  for (const field of node.editableFields) {
    if (
      !supported.has(field) ||
      !disclosed.has(field) ||
      !Object.hasOwn(snapshot.values, field) ||
      readonlyFields.includes(field)
    )
      continue;
    // 与 routes.fieldRights → requireObjectWrite 相同的逐字段写判定，显式 null 也要检查这个字段。
    if (await authorize({ ...ctx, action: 'object.update', resource: snapshot.fieldObjectCode, fields: [field] }))
      editableFields.push(field);
  }
  return editableFields.length ? { editMode: node.editMode, editableFields } : NO_NODE_EDITING;
}
