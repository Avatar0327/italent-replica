/**
 * 实习生路由（R2 BE-6a / BE-6b）：实习四视图（B34～B37）、直接实习转正与结束实习（B41）、按证件号的重聘判定（B38 / A48）。
 * 策略登记在 employment/policy.ts。写权限沿用任职记录的“新增”对象操作与 Employment.Create 按钮（原站“实习转正”是否
 * 另有独立权限项未验证）；结束实习沿用直接离职的权限组合（Employment.Dimission，同样未验证有无独立权限项）；
 * 重聘判定是新增人员流程的一步，沿用 Employee.Create 与“新建员工须看全部”（DEC-121）。
 */
import { withTenant } from '@italent/db';
import { INTERN_VIEWS, PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import {
  EMPLOYEE_OBJECT,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmploymentScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
} from './context.js';
import { parse } from './entry-routes.js';
import {
  createInternEntry,
  internCreateGuard,
  internCreateInput,
  planInternCreate,
  requireInternCreateWrite,
} from './intern-create.js';
import { projectInternProfile } from './intern-profile.js';
import { internRowActions } from './intern-actions.js';
import { internRegularizationInput, regularizationBusiness, regularizeIntern } from './intern-regularization.js';
import { internTerminationGate, internTerminationInput, terminateIntern } from './intern-termination.js';
import { listInternView, type InternViewItem } from './intern-views.js';
import { matchRehire, rehireMatchInput } from './rehire-match.js';
import { exitCommandGuard, internRegularizationGuard } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

const viewFilter = z.strictObject({
  departmentId: z.uuid().optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
});

export function registerInternRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerInternViews(router, deps);
  registerInternCreate(router, deps);
  router.post('/interns/:id/regularize', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const input = parse(internRegularizationInput, await jsonBody(c));
    // 字段写权限按实际写入的任职字段校验，口径同通用新增
    const business = regularizationBusiness(input);
    await requireEmploymentWrite(ctx, 'create', business, 'Employment.Create');
    requireEmploymentScope(ctx, id, input.departmentId);
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'intern-regularize', input },
      async (tx, context) => ({ status: 201, body: await regularizeIntern(tx, context, id, input) }),
      { guard: internRegularizationGuard(deps, ctx, id, business, input.departmentId) },
    );
  });
  // 结束实习（B41）：权限沿用直接离职（Employment.Dimission，原站是否另有独立权限项未验证），保存即生效、不走审批
  router.post('/interns/:id/terminate', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const input = parse(internTerminationInput, await jsonBody(c));
    const gate = internTerminationGate(id, input.endDate);
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'intern-terminate', input },
      async (tx, context) => ({ status: 201, body: await terminateIntern(tx, context, id, input) }),
      { guard: exitCommandGuard(deps, ctx, 'create', gate, {}) },
    );
  });
  router.post('/rehire-matches', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', 0, undefined, EMPLOYEE_OBJECT);
    const input = parse(rehireMatchInput, await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', {}, 'Employee.Create', EMPLOYEE_OBJECT, { commandOnly: true });
    // DEC-121：新员工尚无任职鉴权字段，只有看全部可新建；判定结果会带出离职人员信息，同一门槛
    requireEmploymentScope(ctx);
    const candidate = await withTenant(deps.db, ctx.tenantId, (tx) =>
      matchRehire(tx, ctx.tenantId, input, tenantLocalDate(ctx.now, ctx.timezone)),
    );
    if (!candidate) return c.json({ matched: false });
    const show = await viewableIn(deps, ctx);
    // 结束类型 endKind 是离职 / 退休那条任职的业务类型，按任职记录 kind 字段裁剪；employeeId 是重聘入职要用的标识
    const { name, code, email, lastWorkDate, departmentId, endKind, ...fixed } = candidate;
    const ended = (field: string) => show.employment(field === 'endKind' ? 'kind' : field);
    const visible = {
      ...pick(show.employee, { name, code }),
      ...pick(show.personnel, { email }),
      ...pick(ended, { endKind, lastWorkDate, departmentId }),
    };
    return c.json({ matched: true, candidate: { ...fixed, ...visible } });
  });
}

/**
 * 新增实习生一体写入（BE-R2d4c）：建档 / 重聘 + 实习任职 + 合同协议同一命令事务。权限同 POST /employees（人员新增权 + 看全部，
 * DEC-121）叠加任职新增权与字段权；合同对象权限在命令内复核（首次 / 重放 / 回查）。重聘的 If-Match 是候选人员当前 revision，
 * 新增为 0。固定回执保留人员 / 业务 ID、合同摘要及视图归属；资料快照按当前档案权限独立裁剪。
 */
function registerInternCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/interns', async (c) => {
    const employeeCtx = await readContext(c, deps, 'object.create', 0, undefined, EMPLOYEE_OBJECT);
    const input = parse(internCreateInput, await jsonBody(c));
    const ctx = await readContext(c, deps, 'object.create', revision(c), input.employeeId);
    const plan = planInternCreate(ctx, input);
    await requireInternCreateWrite(employeeCtx, ctx, plan);
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await createInternEntry(tx, deps, context, plan) }),
      {
        guard: internCreateGuard(deps, employeeCtx, ctx, plan),
        project: (body) => projectInternProfile(deps, ctx, body),
      },
    );
  });
}

const pick = (shown: (field: string) => boolean, values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([field]) => shown(field)));

/** 三个对象的可见字段：姓名 / 工号属人员对象，个人邮箱属人员信息，部门 / 最后工作日属任职记录；无字段权限配置 = 全可见。 */
async function viewableIn(deps: TenantRouteDeps, ctx: EmploymentContext) {
  const [employee, personnel, employment] = await Promise.all([
    getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT),
    getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT),
    getModuleViewableFields(deps, ctx, 'TenantBase.EmploymentRecord'),
  ]);
  const has = (set: ReadonlySet<string> | undefined) => (field: string) => set === undefined || set.has(field);
  return { employee: has(employee), personnel: has(personnel), employment: has(employment) };
}

/**
 * 实习四视图：列表按任职记录的数据范围裁剪，字段按任职记录可见字段裁剪；姓名 / 工号按人员对象可见字段另行裁剪
 * （同入职四视图）。按部门筛选要求部门可见、按关键字筛选要求姓名与工号可见，避免用筛选探测不可见字段（同员工列表）。
 */
function registerInternViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/interns', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const view = parse(z.enum(INTERN_VIEWS), c.req.query('view'));
    const filter = parse(viewFilter, { departmentId: c.req.query('departmentId'), keyword: c.req.query('keyword') });
    const page = pageQuery(c);
    const show = await viewableIn(deps, ctx);
    requireViewableInternFilters(filter, show);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listInternView(
        tx,
        ctx.tenantId,
        { view, today: tenantLocalDate(ctx.now, ctx.timezone), page, filter },
        ctx.scope,
      ),
    );
    // F-283：逐行可用动作（写入口同一组判定，intern-actions.ts），在字段裁剪之后附上，不受字段裁剪影响
    const actions = await internRowActions(c, deps, ctx, view, items, show.employment('status'));
    const trimmed = await trimInternItems(deps, ctx, items, show);
    return c.json({
      items: trimmed.map((item, index) => ({ ...item, availableActions: actions[index] })),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
}

type Viewable = Awaited<ReturnType<typeof viewableIn>>;

/** 按部门筛选须部门可见，按关键字（姓名 / 工号）筛选须两者都可见；否则 403，不让筛选成为看不见字段的探针。 */
function requireViewableInternFilters(filter: z.infer<typeof viewFilter>, show: Viewable) {
  const hidden =
    (filter.departmentId !== undefined && !show.employment('departmentId')) ||
    (filter.keyword !== undefined && !(show.employee('name') && show.employee('code')));
  if (hidden) throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

/**
 * 试用期日期逐项按任职记录字段权限裁剪（PR #386 第 1 轮 DEC-406①）。三个编码尚未进字段目录（与 BE-3 统一存储时再登记），
 * 所以有字段限制的人一律看不到（fail-closed），没有字段限制的人可见；一项都不可见时不出 probation 键。
 */
const PROBATION_FIELDS = { startDate: 'probationStartDate', months: 'probationMonths', endDate: 'probationEndDate' };

function trimProbation(probation: InternViewItem['probation'], shown: (field: string) => boolean) {
  const keys = Object.entries(PROBATION_FIELDS).filter(([, code]) => shown(code));
  if (!keys.length) return {};
  return {
    probation: probation && Object.fromEntries(keys.map(([key]) => [key, probation[key as keyof typeof probation]])),
  };
}

/** 业务状态 state 按任职记录 status 字段、姓名 / 工号按人员对象、试用期按上面逐项裁剪（同类位置统一在这里）。 */
async function trimInternItems(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  items: readonly InternViewItem[],
  show: Viewable,
) {
  const records = items.map(({ name: _name, code: _code, state: _state, probation: _probation, ...record }) => record);
  const trimmed = (await trimEmploymentResponse(deps, ctx, records)) as object[];
  return trimmed.map((record, index) => {
    const { state, probation, name, code } = items[index]!;
    return {
      ...record,
      ...(show.employment('status') ? { state } : {}),
      ...trimProbation(probation, show.employment),
      ...pick(show.employee, { code, name }),
    };
  });
}
