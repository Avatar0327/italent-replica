/** F-228：PB-R9 的提示明细与批量回执重放共用披露入口，互斥判定不随查看权放行。 */
import { isUuid, withTenant, type Tx } from '@italent/db';
import { APPROVAL_INSTANCE_OBJECT, buttonResource, PROBATION_ASSESSMENT_OBJECT } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { instanceScopeSql } from '../approval/access.js';
import { latestInstanceOf } from '../approval/store.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { requireAssessmentInScope } from './assessment-store.js';
import type { EmploymentContext } from './types.js';

const REASON = 'PROBATION_PROCESS_IN_REVIEW';
const GENERIC_MESSAGE = '该员工存在未完成的考核，不能再发起转正、考核或调整试用期';
const DETAIL_FIELDS = ['id', 'assessmentName', 'assessmentDate'] as const;

interface Conflict {
  readonly code: string;
  readonly message: string;
  readonly details: { readonly reason: string; readonly process: string; readonly assessmentId: string };
}

function isConflict(value: unknown): value is Conflict {
  if (!value || typeof value !== 'object') return false;
  const error = value as Partial<Conflict>;
  return (
    error.code === 'CONFLICT' &&
    error.details?.reason === REASON &&
    ['probation_assessment', 'regularization_assessment'].includes(error.details.process) &&
    typeof error.details.assessmentId === 'string' &&
    isUuid(error.details.assessmentId)
  );
}

/** 仅把可见性拒绝视为不可见；数据库 / 配置错误不得吞掉后继续发起业务。 */
async function visible(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

async function canDisclose(tx: Tx, ctx: EmploymentContext, assessmentId: string): Promise<boolean> {
  // 审批回调等没有注入授权器的内部上下文不代表查看人拥有“看全部”。
  if (!ctx.authorize) return false;
  const deps = { authorize: authorizeInTransaction(ctx.authorize, tx), clock: () => ctx.now };
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, PROBATION_ASSESSMENT_OBJECT, tx);
  // 提示中的名称 / 日期 / 定位 ID 作为一组明细；缺任一查看权就只显示通用原因，重放时也无需保留隐蔽定位字段。
  if (fields && !DETAIL_FIELDS.every((field) => fields.has(field))) return false;
  if (await deps.authorize({ ...ctx, action: 'object.view', resource: PROBATION_ASSESSMENT_OBJECT })) {
    const scope = await resolveModuleScopeInTransaction(
      deps,
      ctx,
      tx,
      PROBATION_ASSESSMENT_OBJECT,
      `${PROBATION_ASSESSMENT_OBJECT}.detail`,
    );
    if (await visible(() => requireAssessmentInScope(tx, { ...ctx, scope }, { id: assessmentId }))) return true;
  }

  const instance = await latestInstanceOf(tx, ctx.tenantId, 'probation_assessment', assessmentId);
  if (!instance) return false;
  // 考核实例在审批中心沿用任职记录列表范围；复用同一实例谓词和 readDetail 的参与人 / 管理员判定。
  const adminScope = async (button: 'adminTransfer' | 'adminIntervene') => {
    const allowed = await deps.authorize({
      ...ctx,
      action: 'object.button',
      resource: buttonResource(APPROVAL_INSTANCE_OBJECT, button, 'detail'),
    });
    if (!allowed) return null;
    const object = 'TenantBase.EmploymentRecord';
    return instanceScopeSql(ctx, await resolveModuleScopeInTransaction(deps, ctx, tx, object, `${object}.list`));
  };
  const viewer = {
    userId: ctx.userId,
    transferScope: await adminScope('adminTransfer'),
    interveneScope: await adminScope('adminIntervene'),
  };
  let readable = false;
  await visible(async () => {
    // runWrite 随任职读模型加载；延迟进入审批披露，避免 store → 任职 → 审批 → store 的初始化环。
    const { disclosedFields, readDetail } = await import('../approval/disclosure.js');
    const data = await readDetail(tx, ctx, instance.id, viewer, false);
    const disclosed = disclosedFields(data, ctx.userId, fields);
    readable = disclosed.has('assessmentName') && disclosed.has('assessmentDate');
  });
  return readable;
}

/** 首次检查点与重放都在租户事务内按当前权限裁剪；只裁剪 PB-R9 考核冲突，不碰其他错误协议。 */
export async function discloseAssessmentConflict(tx: Tx, ctx: EmploymentContext, error: Conflict) {
  if (await canDisclose(tx, ctx, error.details.assessmentId)) return error;
  return {
    code: error.code,
    message: GENERIC_MESSAGE,
    details: { reason: error.details.reason, process: error.details.process },
  };
}

/** 批量失败回执也会进台账；重放只收紧已保存明细，不扩展原回执、也不重新执行互斥检查。 */
export async function discloseAssessmentConflictReceipt(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  body: unknown,
): Promise<unknown> {
  if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items)) return body;
  const items = body.items as unknown[];
  const hasConflict = (item: unknown): item is { error: Conflict } =>
    !!item && typeof item === 'object' && 'error' in item && isConflict(item.error);
  if (!items.some(hasConflict)) return body;
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const current = { ...ctx, now: deps.clock(), authorize: authorizeInTransaction(deps.authorize, tx) };
    const projected = [];
    for (const item of items)
      projected.push(
        hasConflict(item) ? { ...item, error: await discloseAssessmentConflict(tx, current, item.error) } : item,
      );
    return { ...body, items: projected };
  });
}
