/**
 * 继任管理的权限接入（R3-T05 设计 §8；DEC-080 单一权限模型）：对象目录在领域层（SUCCESSION_OBJECTS），这里登记进
 * 权限目录；数据范围按对象所属应用 SuccessionAndDevelopment 解析（permission/module-access.ts scopeAppOf，
 * DEC-043、#107），缺省为空。路由的对象 / 按钮 / 字段 / 范围判定随 PR-A～PR-D 在本目录追加（设计 §2.1）。
 */
import { SUCCESSION_OBJECTS, type SuccessionObject } from '@italent/domain';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';

for (const definition of Object.values(SUCCESSION_OBJECTS)) registerObjectDefinition(definition);

/** 审计动作前缀（`<前缀>.create|update|delete|…`）；审计查看规则按它取创建人（audit-scope.ts、DEC-198）。 */
export const SUCCESSION_AUDIT_ACTIONS: Readonly<Record<SuccessionObject, string>> = {
  record: 'succession.record',
  map: 'succession.map',
  riskResult: 'succession.risk-result',
  healthResult: 'succession.health-result',
  riskLevel: 'succession.risk-level',
  healthLevel: 'succession.health-level',
  population: 'succession.population',
  ruleSettings: 'succession.rule-settings',
  calcRun: 'succession.calc-run',
  syncBatch: 'succession.sync-batch',
};

export const SUCCESSION_BASE = '/api/tenant/succession';
export const codeOf = (object: SuccessionObject) => SUCCESSION_OBJECTS[object].code;
export type SuccessionContext = ScopeBusinessContext;

/** 读入口：对象查看权（objectContext）；写入口的按钮 / 字段校验随 A2 追加（设计 §2.1 第 1 步）。 */
export function successionContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: SuccessionObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<SuccessionContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

/** 当前请求的数据范围（每次请求按当前权限解析，撤权后立即生效；同一请求内缓存）。 */
export const successionScope = (
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  object: SuccessionObject,
) => requestScope(c, deps, ctx, codeOf(object));

/** 列表筛选用到的字段须有查看权，否则 403（不能用筛选结果还原被裁掉的字段值）。 */
export async function requireFilterVisible(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  object: SuccessionObject,
  field: string,
): Promise<void> {
  const fields = await getModuleViewableFields(deps, ctx, codeOf(object));
  if (fields !== undefined && !fields.has(field)) {
    throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field });
  }
}
