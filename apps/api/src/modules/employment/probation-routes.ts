/**
 * 试用期与转正路由（R2 BE-3；docs/02_业务建模/29 §2.1 / §2.3，差距表 B1 / B3～B8）：
 * 四个视图、试用人员详情、调整试用信息、单个 / 批量转正、试用结果字典。策略登记在 employment/policy.ts。
 * 权限沿用任职记录对象：视图 / 详情 = 查看；调整试用信息 = 编辑 + Employment.Edit；转正 = 新增 + Employment.Create；
 * 字典读取 = 任职记录查看，写入 = 任职设置配置对象（同离职字典）。授权项编码不变。
 */
import { withTenant } from '@italent/db';
import { PROBATION_MONTHS_MAX, PROBATION_MONTHS_MIN, PROBATION_VIEWS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import {
  commandContext,
  EMPLOYEE_OBJECT,
  jsonBody,
  pageQuery,
  queryDate,
  readContext,
  readPageContext,
  requireEmployeeInScope,
  requireEmploymentScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  scopedGuard,
  trimEmploymentResponse,
  uuidParam,
} from './context.js';
import { parse, type BusinessWriteGuard } from './entry-routes.js';
import { requirePermission } from '../../authorization.js';
import { adjustProbation, probationDetail } from './probation.js';
import { listProbationResults, parseProbationResultInput, saveProbationResult } from './probation-results.js';
import { listProbationView, PROBATION_VIEW_CONTROLS, type ProbationViewItem } from './probation-views.js';
import { createRegularizationBusiness, parseRegularizationInput, regularizeEmployees } from './regularization.js';
import { parseRegularizationBusinessInput } from './fields.js';
import { rescheduleRegularization } from './regularization-reschedule.js';
import { pendingActionGuard } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

const date = z.iso.date();
const adjustInput = z.strictObject({
  hasProbation: z.boolean(),
  startDate: date.nullable().optional(),
  months: z.int().min(PROBATION_MONTHS_MIN).max(PROBATION_MONTHS_MAX).nullable().optional(),
  expectedEndDate: date.nullable().optional(),
  regularizationDate: date.nullable().optional(),
});
const viewQuery = z.strictObject({
  view: z.enum(PROBATION_VIEWS),
  employeeId: z.uuid().optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
  departmentId: z.uuid().optional(),
  postId: z.uuid().optional(),
  expectedEndFrom: date.optional(),
  expectedEndTo: date.optional(),
});
const enabledQuery = z.enum(['true', 'false']).optional();
const SETTINGS = 'TenantBase.EmploymentSettings';

/** 调整试用信息 / 转正的命令内复核（#199 CommandGuard.before）：按当前授权重过入口的对象、按钮、字段与员工范围。 */
function probationWriteGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  operation: 'create' | 'update',
  payload: object,
  employeeIds: readonly string[],
) {
  return scopedGuard({
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requirePermission(scoped.authorize!, {
        ...scoped,
        action: `object.${operation}`,
        resource: scoped.objectCode!,
        fields: [],
      });
      await requireEmploymentWrite(
        scoped,
        operation,
        payload,
        operation === 'create' ? 'Employment.Create' : 'Employment.Edit',
        undefined,
        { commandOnly: Object.keys(payload).length === 0 },
      );
      // 批量转正逐人在保存点里判范围（只让那一人失败）；单人调整在这里整单拒绝
      for (const employeeId of employeeIds) await requireEmployeeInScope(tx, scoped, employeeId);
    },
    // 同键重放：回执里的每一人（成功与失败都算）按当前范围复核，撤权后拿不到原回执
    replayed: async (tx, replay) => {
      const scoped = await commandContext(tx, deps, ctx);
      const receipt = replay.body as { items?: readonly { employeeId: string }[] } | null;
      for (const item of receipt?.items ?? []) await requireEmployeeInScope(tx, scoped, item.employeeId);
    },
  });
}

/** 通用入口请求体里的试用结果（转正控制项，不进任职字段校验）；不是对象或没带时原样返回。 */
export function splitProbationResult(body: unknown): { rawInput: unknown; probationResult: unknown } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('probationResult' in body))
    return { rawInput: body, probationResult: undefined };
  const { probationResult, ...rawInput } = body as Record<string, unknown>;
  return { rawInput, probationResult };
}

/**
 * 通用入口 POST /employees/:id/businesses 的转正（kind=regularization）：权限与范围同通用入口（对象新增 + Employment.Create
 * 按钮 + 带部门时的写入口径范围），办理交 createRegularizationBusiness（第 1 轮审查 P2-3）。
 */
export async function createRegularizationViaBusinesses(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  body: unknown,
  probationResult: unknown,
) {
  const input = parseRegularizationBusinessInput(body);
  const result = parse(z.string().trim().min(1).max(100).optional(), probationResult);
  await requireEmploymentWrite(ctx, 'create', body as object, 'Employment.Create');
  if (input.fields.departmentId !== undefined) requireEmploymentScope(ctx, id, input.fields.departmentId);
  const request = {
    kind: 'regularization' as const,
    mode: input.mode,
    formId: input.formId,
    fields: input.fields,
    customFields: input.customFields,
    ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
    ...(result ? { probationResult: result } : {}),
  };
  return runWrite(c, deps, ctx, request, async (tx, context) => ({
    status: 201,
    body: await createRegularizationBusiness(tx, context, id, request),
  }));
}

export function registerProbationRoutes(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  registerProbationViews(router, deps);
  router.put('/employees/:id/probation', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), id);
    const input = parse(adjustInput, await jsonBody(c));
    // 试用期字段是控制项、不在任职字段目录：同待入职动作，只校验编辑按钮（命令式空字段集合）
    await requireEmploymentWrite(ctx, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true });
    const adjustment = {
      hasProbation: input.hasProbation,
      startDate: input.startDate ?? null,
      months: input.months ?? null,
      expectedEndDate: input.expectedEndDate ?? null,
      regularizationDate: input.regularizationDate ?? null,
    };
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'adjust-probation', input },
      async (tx, context) => {
        await adjustProbation(tx, context, id, adjustment);
        const today = tenantLocalDate(context.now, context.timezone);
        // 回执只带员工、revision 与试用信息（控制项），不带入职日期、任职记录行等任职字段
        const detail = await probationDetail(tx, context, id, today);
        const { records: _records, recordId: _recordId, entryDate: _entryDate, ...info } = detail;
        return { status: 200, body: info };
      },
      { guard: probationWriteGuard(deps, ctx, 'update', {}, [id]), project: (body) => body },
    );
  });
  router.post('/regularizations', async (c) => {
    const ctx = await readContext(c, deps, 'object.create');
    const input = parseRegularizationInput(await jsonBody(c));
    const payload = {
      kind: 'regularization',
      mode: input.mode,
      ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
    };
    await requireEmploymentWrite(ctx, 'create', payload, 'Employment.Create');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 200, body: await regularizeEmployees(tx, context, input) }),
      // 回执是固定形状（逐人状态 / 业务 ID / 错误），不含任职字段值
      { guard: probationWriteGuard(deps, ctx, 'create', payload, []), project: (body) => body },
    );
  });
  registerRegularizationReschedule(router, deps, authorizeBusinessWrite);
  registerProbationResults(router, deps);
}

/**
 * 转正改期（PB-R13，DEC-589）：If-Match = 转正单 revision；body 严格 { effectiveDate }；权限同待入职改期：对象编辑、
 * Employment.Edit 按钮与生效日期字段写权限、业务写入口径范围，命令内经 CommandGuard.before 按当前授权再过一遍。
 */
function registerRegularizationReschedule(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  router.post('/businesses/:id/regularization-date', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const input = parse(z.strictObject({ effectiveDate: date }), await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit');
    await authorizeBusinessWrite(deps, ctx, id);
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'reschedule-regularization', input },
      async (tx, context) => ({
        status: 200,
        body: await rescheduleRegularization(tx, context, id, input.effectiveDate),
      }),
      { guard: pendingActionGuard(deps, ctx, id, input) },
    );
  });
}

/** 四个视图（PB-R1）与试用人员详情（B6）：按任职记录数据范围裁剪；姓名 / 工号按人员对象可见字段另行裁剪。 */
function registerProbationViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/probation-views', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    // 分页参数由 pageQuery 校验；其余查询参数严格校验，未知参数 400
    const query = Object.entries(c.req.query()).filter(([key]) => !['page', 'pageSize'].includes(key));
    const { view, ...filter } = parse(viewQuery, Object.fromEntries(query));
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listProbationView(
        tx,
        ctx.tenantId,
        { view, filter, page, today: tenantLocalDate(ctx.now, ctx.timezone) },
        ctx.scope,
      ),
    );
    const identity = await getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT);
    const shown = (field: string) => identity === undefined || identity.has(field);
    const strip = (item: ProbationViewItem) =>
      Object.fromEntries(
        Object.entries(item).filter(
          ([key]) => !['name', 'code', 'organizationId', ...PROBATION_VIEW_CONTROLS].includes(key),
        ),
      );
    const trimmed = (await trimEmploymentResponse(deps, ctx, items.map(strip))) as object[];
    return c.json({
      items: trimmed.map((record, index) => {
        const item = items[index]!;
        return {
          ...record,
          ...Object.fromEntries(PROBATION_VIEW_CONTROLS.map((key) => [key, item[key]])),
          // 机构随部门派生：部门可见才给机构（第 1 轮审查 P2-5）
          ...('departmentId' in record ? { organizationId: item.organizationId } : {}),
          ...(shown('code') ? { code: item.code } : {}),
          ...(shown('name') ? { name: item.name } : {}),
        };
      }),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  router.get('/employees/:id/probation', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail', id);
    const detail = await withTenant(deps.db, ctx.tenantId, (tx) => probationDetail(tx, ctx, id, queryDate(c, ctx)));
    // 员工 / 记录键与记录行（id / kind / effectiveDate / employeeStatus）按任职字段权逐层裁剪；
    // 试用信息与转正日期投影是控制项（不在任职字段目录），员工可见即可见
    const { records, employeeId, revision: employeeRevision, recordId, entryDate, ...controls } = detail;
    const base = { employeeId, revision: employeeRevision, recordId, entryDate, items: records };
    const { items, ...trimmed } = (await trimEmploymentResponse(deps, ctx, base)) as { items: object[] };
    return c.json({
      ...trimmed,
      ...controls,
      records: items.map((record, index) => ({ ...record, regularizationDate: records[index]!.regularizationDate })),
    });
  });
}

/** 试用结果字典：读取对持任职记录查看权者开放（转正表单下拉），写入是任职设置配置对象（同离职字典）。 */
function registerProbationResults(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/probation-results', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0);
    const enabled = parse(enabledQuery, c.req.query('enabled'));
    const filter = enabled === undefined ? {} : { enabled: enabled === 'true' };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listProbationResults(tx, ctx.tenantId, filter));
    return c.json({ items });
  });
  router.post('/probation-results', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.configuration.write', revision(c), undefined, SETTINGS);
    const input = parseProbationResultInput(await jsonBody(c), 'create');
    await requireEmploymentWrite(ctx, 'create', input, undefined, SETTINGS);
    return runWrite(c, deps, ctx, { input }, async (tx, context) => ({
      status: 201,
      body: await saveProbationResult(tx, context, input),
    }));
  });
  router.put('/probation-results/:id', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.configuration.write', revision(c), undefined, SETTINGS);
    const id = uuidParam(c);
    const input = parseProbationResultInput(await jsonBody(c), 'update');
    await requireEmploymentWrite(ctx, 'update', input, undefined, SETTINGS);
    return runWrite(c, deps, ctx, { id, input }, async (tx, context) => ({
      status: 200,
      body: await saveProbationResult(tx, context, input, id),
    }));
  });
}
