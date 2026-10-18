/**
 * 试用期考核写入的权限与范围复核——发起 / 修改（assessment-routes.ts）与审批中心重提（approval/access.ts resubmitGuard）
 * 共用这一个入口（DEC-431①）：对象数据操作 + 字段写权限 + 详情级按钮（Assessment.Create / Assessment.Edit），再加考核对象
 * 的数据范围（范围外与考核不存在同一个 404「考核记录不存在」）。全部在命令事务内、按“当前”授权判定（DEC-455 / #199）。
 */
import type { Tx } from '@italent/db';
import { PROBATION_ASSESSMENT_OBJECT } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { parseAssessmentPatch } from './assessment.js';
import { loadAssessment, requireAssessmentInScope } from './assessment-store.js';
import { requireEmploymentWrite } from './context.js';
import type { EmploymentContext } from './types.js';

/**
 * ctx 须已带事务内授权器与数据范围（路由用 commandContext，审批重提用 assessmentCommandContext）。
 * assessmentId 给出时再判该考核的考核对象在范围内；权限先于存在性判定（无权的人拿不到 404 / 403 的差异）。
 */
export async function requireAssessmentWrite(
  tx: Tx,
  ctx: EmploymentContext,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
  assessmentId?: string,
): Promise<void> {
  const button = operation === 'create' ? 'Assessment.Create' : 'Assessment.Edit';
  await requireEmploymentWrite(ctx, operation, payload, button, PROBATION_ASSESSMENT_OBJECT);
  if (assessmentId) await requireAssessmentInScope(tx, ctx, await loadAssessment(tx, ctx.tenantId, assessmentId));
}

/** 审批中心命令里的考核上下文：授权器绑定本事务，数据范围按当前授权在本事务内解析（不沿用请求前的快照）。 */
async function assessmentCommandContext(tx: Tx, deps: TenantRouteDeps, ctx: TenantContext): Promise<EmploymentContext> {
  return {
    ...ctx,
    now: deps.clock(),
    commandId: '',
    expectedRevision: 0,
    objectCode: PROBATION_ASSESSMENT_OBJECT,
    authorize: authorizeInTransaction(deps.authorize, tx),
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, PROBATION_ASSESSMENT_OBJECT),
  };
}

/**
 * 被驳回的考核由发起人在审批中心重提：与重新发起同一权限（创建权限 + 按钮 + 基础字段 + 修正字段的写权限）和同一数据范围。
 * 修正内容（审批节点可编辑的字段）先按考核字段解析，非法取值 400。
 */
export async function requireAssessmentResubmitRight(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  assessmentId: string,
  corrections: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const row = await loadAssessment(tx, ctx.tenantId, assessmentId);
  const patch = Object.keys(corrections).length ? parseAssessmentPatch(corrections) : {};
  const scoped = await assessmentCommandContext(tx, deps, ctx);
  await requireAssessmentWrite(
    tx,
    scoped,
    'create',
    {
      assessmentType: row.assessmentType,
      assessmentName: row.assessmentName,
      assessmentDate: row.assessmentDate,
      ...patch,
    },
    assessmentId,
  );
}
