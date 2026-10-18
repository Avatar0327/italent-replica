/**
 * 试用期考核路由（R2 BE-15b1；docs/02_业务建模/29 PB-R3～R6，差距表 B2；挂在任职子应用 policedSub 上，策略登记在
 * employment/policy.ts）：选人批量发起、列表、详情、审批通过后修改。权限是考核对象 TenantBase.ProbationAssessment 的
 * 数据操作 + 按钮（create@list / update@detail），数据范围按考核对象所在应用（与任职记录同应用）裁剪到考核对象员工；
 * 命令内经 CommandGuard.before 按当前授权再过一遍（#199）。审批流转（自评 / 评价 / 通过）走审批中心，不在这里。
 */
import { sql, withTenant } from '@italent/db';
import {
  ASSESSMENT_BUTTONS,
  ASSESSMENT_STATUSES,
  ASSESSMENT_TYPE_CODES,
  isParallelRuleValue,
  PARALLEL_RULE_KEYS,
  PROBATION_ASSESSMENT_OBJECT,
  type ParallelRuleBlocker,
} from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { CommandGuard } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  createAssessments,
  parseAssessmentBatch,
  parseAssessmentPatch,
  updateAssessment,
  type AssessmentBatchInput,
} from './assessment.js';
import { assessmentView, listAssessments, loadAssessment } from './assessment-store.js';
import {
  commandContext,
  employmentScopePredicate,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmployeeInScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  scopedGuard,
  trimEmploymentResponse,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { parse } from './entry-routes.js';

// 考核并行规则（PB-R9 例外）：两个开关各一个两层配置，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验
for (const blocker of Object.keys(PARALLEL_RULE_KEYS) as ParallelRuleBlocker[])
  registerSettingValidator(PARALLEL_RULE_KEYS[blocker], (value) => isParallelRuleValue(blocker, value));

const listQuery = z.strictObject({
  employeeId: z.uuid().optional(),
  status: z.enum(Object.keys(ASSESSMENT_STATUSES) as [keyof typeof ASSESSMENT_STATUSES]).optional(),
  assessmentType: z.enum(ASSESSMENT_TYPE_CODES).optional(),
});

/** 命令事务内的当前权限复核；employeeIds 为本次涉及的员工（批量发起逐人在保存点里判范围，这里只复核重放）。 */
function assessmentGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
  employeeOf?: (tx: Parameters<NonNullable<CommandGuard['before']>>[0]) => Promise<readonly string[]>,
) {
  return scopedGuard({
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireEmploymentWrite(scoped, operation, payload, ASSESSMENT_BUTTONS[operation], PROBATION_ASSESSMENT_OBJECT);
      for (const employeeId of (await employeeOf?.(tx)) ?? []) await requireEmployeeInScope(tx, scoped, employeeId);
    },
    // 同键重放：回执里的每一人按当前范围复核，撤权后拿不到原回执
    replayed: async (tx, replay) => {
      const scoped = await commandContext(tx, deps, ctx);
      const body = replay.body as { items?: readonly { employeeId: string }[]; employeeId?: string } | null;
      for (const item of body?.items ?? []) await requireEmployeeInScope(tx, scoped, item.employeeId);
      if (body?.employeeId) await requireEmployeeInScope(tx, scoped, body.employeeId);
    },
  });
}

export function registerAssessmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/probation-assessments', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', 0, undefined, PROBATION_ASSESSMENT_OBJECT);
    const input: AssessmentBatchInput = parseAssessmentBatch(await jsonBody(c));
    const payload = {
      assessmentType: input.assessmentType,
      assessmentName: input.assessmentName,
      assessmentDate: input.assessmentDate,
    };
    await requireEmploymentWrite(ctx, 'create', payload, ASSESSMENT_BUTTONS.create, PROBATION_ASSESSMENT_OBJECT);
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 200, body: await createAssessments(tx, context, input) }),
      // 回执是固定形状（逐人状态 / 考核 ID / 错误），不含考核字段值
      { guard: assessmentGuard(deps, ctx, 'create', payload), project: (body) => body },
    );
  });
  router.get('/probation-assessments', async (c) => {
    const ctx = await readPageContext(c, deps, 'list', undefined, PROBATION_ASSESSMENT_OBJECT);
    const query = Object.entries(c.req.query()).filter(([key]) => !['page', 'pageSize'].includes(key));
    const filter = parse(listQuery, Object.fromEntries(query));
    const page = pageQuery(c);
    const rows = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listAssessments(
        tx,
        ctx.tenantId,
        filter,
        employmentScopePredicate(ctx.scope, sql`a.employee_id`, sql`a.department_id`),
        page,
      ),
    );
    const items = await trimEmploymentResponse(deps, ctx, rows.map(assessmentView));
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get('/probation-assessments/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail', undefined, PROBATION_ASSESSMENT_OBJECT);
    const row = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await loadAssessment(tx, ctx.tenantId, id);
      // 范围外与不存在同一个 404
      await requireEmployeeInScope(tx, ctx, found.employeeId);
      return found;
    });
    return c.json(await trimEmploymentResponse(deps, ctx, assessmentView(row)));
  });
  router.patch('/probation-assessments/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, PROBATION_ASSESSMENT_OBJECT);
    const patch = parseAssessmentPatch(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', patch, ASSESSMENT_BUTTONS.update, PROBATION_ASSESSMENT_OBJECT);
    return runWrite(
      c,
      deps,
      ctx,
      { id, patch },
      async (tx, context) => ({ status: 200, body: await updateAssessment(tx, context, id, patch) }),
      {
        guard: assessmentGuard(deps, ctx, 'update', patch, async (tx) => [
          (await loadAssessment(tx, ctx.tenantId, id)).employeeId,
        ]),
      },
    );
  });
}
