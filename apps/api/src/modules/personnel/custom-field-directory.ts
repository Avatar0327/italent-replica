// F-474-6c 第 2 轮：业务侧自定义字段定义目录（Codex 审查 P2-2）。
// 配置接口要配置管理能力，普通人员 HR 读它得 403、字段整体消失；业务页面改读这里：
// 只回查看者对 custom:<id> 有查看权的定义，且只给展示所需的最小字段（不含编码、继承、版本号）。
// 裁剪逻辑按（对象类型 + 对象授权编码）参数化，组织侧（6b）复用同一函数，只需传自己的两个参数。
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { CUSTOM_FIELD_LIMIT, type CustomFieldObjectType, type CustomFieldOption } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { editableModuleFields, getModuleViewableFields } from '../permission/module-access.js';
import { rows } from './store.js';

export interface CustomFieldDirectoryItem {
  readonly id: string;
  readonly name: string;
  readonly valueType: string;
  readonly options: readonly CustomFieldOption[];
  readonly editable: boolean;
}
export interface CustomFieldDirectoryDeps {
  readonly db: Db;
  readonly authorize: Authorizer;
  readonly clock: () => Date;
}
export interface CustomFieldDirectoryTarget {
  /** 定义所属对象（employment_custom_field_objects.object_type）。 */
  readonly objectType: CustomFieldObjectType;
  /** 该对象的授权编码（如 TenantBase.EmployeeInformation），查看 / 编辑权都按它解析。 */
  readonly objectCode: string;
}
type Definition = { id: string; name: string; valueType: string; options: CustomFieldOption[] };

export async function listVisibleCustomFields(
  deps: CustomFieldDirectoryDeps,
  ctx: TenantContext,
  target: CustomFieldDirectoryTarget,
): Promise<CustomFieldDirectoryItem[]> {
  const viewable = await getModuleViewableFields(deps, ctx, target.objectCode);
  const now = deps.clock();
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const found = await definitions(tx, ctx.tenantId, target.objectType);
    // viewable 为 undefined 表示全部字段可见（无权限提供方的授权器）；其余按 custom:<id> 精确匹配。
    const visible = found.filter((item) => viewable === undefined || viewable.has(`custom:${item.id}`));
    if (!visible.length) return [];
    const editable = await editableModuleFields(deps.authorize, tx, { ...ctx, now }, target.objectCode);
    // 没有权限提供方的授权器（只出现在测试装配里）解析不出逐字段编辑集合：一律按不可编辑，宁缺勿滥（fail-closed）。
    return visible.map((item) => ({ ...item, editable: editable?.has(`custom:${item.id}`) ?? false }));
  });
}

async function definitions(tx: Tx, tenantId: string, objectType: CustomFieldObjectType): Promise<Definition[]> {
  const found = rows<Definition>(
    await tx.execute(sql`SELECT id::text AS id, name, value_type AS "valueType", options
      FROM employment_custom_field_objects
      WHERE tenant_id=${tenantId}::uuid AND object_type=${objectType}
      ORDER BY id LIMIT ${CUSTOM_FIELD_LIMIT + 1}`),
  );
  if (found.length > CUSTOM_FIELD_LIMIT) throw new AppError('SERVICE_UNAVAILABLE', '自定义字段数量超出当前处理预算');
  return found;
}
