/**
 * 人才盘点的权限接入（设计 §6.1；DEC-080 单一权限模型；AGENTS §10「权限」每次请求重验）：
 * - 对象目录在领域层（TALENT_REVIEW_OBJECTS），这里登记进权限目录；数据范围按对象所属应用 TalentReview 解析
 *   （permission/module-access.ts scopeAppOf，DEC-043），缺省为空；
 * - 设置类配置对象（准备度等）没有组织字段：只认看全部或创建人（DEC-121），新建只有看全部可建（DEC-082）；
 * - 写入口 = 数据操作权 + 按钮（REQ-PRM-001 R6），载荷逐字段校验编辑权，首次执行与幂等重放都经过这里。
 */
import { sql } from '@italent/db';
import { TALENT_REVIEW_OBJECT_LABELS, TALENT_REVIEW_OBJECTS, type TalentReviewObject } from '@italent/domain';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import { AppError } from '../../errors.js';
import {
  button,
  hasCreatorScope,
  objectContext,
  requestScope,
  trimModuleResponse,
  visible,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';

for (const definition of Object.values(TALENT_REVIEW_OBJECTS)) registerObjectDefinition(definition);

export type TalentReviewContext = ScopeBusinessContext;
export type { ModuleScope };

export const TALENT_REVIEW_BASE = '/api/tenant/talent-review';
export const codeOf = (object: TalentReviewObject) => TALENT_REVIEW_OBJECTS[object].code;
const notFound = (object: TalentReviewObject) => `${TALENT_REVIEW_OBJECT_LABELS[object]}不存在`;

/** 审计动作前缀（`<前缀>.create|update|delete`）；审计查询的查看规则按它登记（audit/visibility.ts）。 */
export const TALENT_REVIEW_AUDIT_ACTIONS: Readonly<Record<TalentReviewObject, string>> = {
  readiness: 'talent-review.readiness',
  settings: 'talent-review.settings',
  category: 'talent-review.category',
  role: 'talent-review.role',
  field: 'talent-review.field',
  scoreRule: 'talent-review.score-rule',
  moduleGrade: 'talent-review.module-grade',
  mapping: 'talent-review.field-mapping',
  matrix: 'talent-review.matrix',
  calcRule: 'talent-review.calc-rule',
  resultApproval: 'talent-review.result-approval',
};

const WRITE_BUTTONS = {
  create: ['create', 'list'],
  update: ['update', 'detail'],
  delete: ['delete', 'detail'],
} as const;

export function reviewContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: TalentReviewObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<TalentReviewContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

/** 写入口：数据操作权 + 按钮，在进入命令台账之前校验（撤掉按钮后重放同样 403）。 */
export async function reviewWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: TalentReviewObject,
  operation: keyof typeof WRITE_BUTTONS,
  expectedRevision: number,
): Promise<TalentReviewContext> {
  const ctx = await reviewContext(c, deps, object, operation, expectedRevision);
  const [code, level] = WRITE_BUTTONS[operation];
  await button(deps, ctx, codeOf(object), code, level);
  return ctx;
}

export const reviewScope = (
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: TalentReviewObject,
) => requestScope(c, deps, ctx, codeOf(object));

export const checkWriteFields = (
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: TalentReviewObject,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) => writeFields(deps, ctx, codeOf(object), operation, payload);

/** 配置对象（无组织字段）：看全部或创建人；范围外与不存在同一个 404。 */
export function requireConfigVisible(scope: ModuleScope, object: TalentReviewObject, createdBy: string | null) {
  visible(scope, undefined, notFound(object), createdBy);
}

/** 配置对象新建：只有看全部可建（DEC-082 / DEC-121），否则按不存在 404。 */
export function requireConfigCreatable(scope: ModuleScope, object: TalentReviewObject) {
  visible(scope, undefined, notFound(object));
}

/** 列表筛选用到的字段须有查看权，否则 403（不能用筛选结果还原被裁掉的字段值）。 */
export async function requireFilterVisible(
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: TalentReviewObject,
  field: string,
): Promise<void> {
  const fields = await getModuleViewableFields(deps, ctx, codeOf(object));
  if (fields !== undefined && !fields.has(field)) {
    throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field });
  }
}

/** 列表的 SQL 侧范围谓词（分页之前生效）：配置对象按创建人。 */
export const configScopeSql = (scope: ModuleScope, table: string) =>
  scopeSql(scope, { creator: sql`${sql.identifier(table)}.created_by` });

/** 列表信封：查看人在该配置对象上有没有任何数据范围（看全部或创建人规则）。 */
export const configEnvelope = (page: { page: number; pageSize: number }, scope: ModuleScope) => ({
  page: page.page,
  pageSize: page.pageSize,
  hasDataPermission: scope.all || hasCreatorScope(scope),
});

export const trimReview = <T extends object>(
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: TalentReviewObject,
  value: T[],
): Promise<Partial<T>[]> => trimModuleResponse(deps, ctx, codeOf(object), value) as Promise<Partial<T>[]>;

export const notFoundMessage = notFound;
