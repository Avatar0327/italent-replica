/**
 * 实习生路由（R2 BE-6a）：实习四视图（B34～B37）、直接实习转正（B41）、按证件号的重聘判定（B38 / A48）。
 * 策略登记在 employment/policy.ts。写权限沿用任职记录的“新增”对象操作与 Employment.Create 按钮（原站“实习转正”是否
 * 另有独立权限项未验证）；重聘判定是新增人员流程的一步，沿用 Employee.Create 与“新建员工须看全部”（DEC-121）。
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
import { internRegularizationInput, regularizationFields, regularizeIntern } from './intern-regularization.js';
import { listInternView, type InternViewItem } from './intern-views.js';
import { matchRehire, rehireMatchInput } from './rehire-match.js';
import { internRegularizationGuard } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

const viewFilter = z.strictObject({
  departmentId: z.uuid().optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
});

export function registerInternRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerInternViews(router, deps);
  router.post('/interns/:id/regularize', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const input = parse(internRegularizationInput, await jsonBody(c));
    // 字段写权限按实际写入的任职字段校验，口径同通用新增
    const business = {
      kind: 'intern_regularization',
      mode: 'direct',
      effectiveDate: input.effectiveDate,
      fields: regularizationFields(input),
    };
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
    const { name, code, email, lastWorkDate, departmentId, ...fixed } = candidate;
    const visible = { ...pick(show.employee, { name, code }), ...pick(show.personnel, { email }) };
    return c.json({
      matched: true,
      candidate: { ...fixed, ...visible, ...pick(show.employment, { lastWorkDate, departmentId }) },
    });
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
    requireViewableInternFilters(filter, await viewableIn(deps, ctx));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listInternView(
        tx,
        ctx.tenantId,
        { view, today: tenantLocalDate(ctx.now, ctx.timezone), page, filter },
        ctx.scope,
      ),
    );
    return c.json({
      items: await trimInternItems(deps, ctx, items),
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

/** state / probation 是视图控制项、不在任职字段目录，通用投影会裁掉：先摘下，裁剪后放回（行可见即可见，同入职视图）。 */
async function trimInternItems(deps: TenantRouteDeps, ctx: EmploymentContext, items: readonly InternViewItem[]) {
  const show = await viewableIn(deps, ctx);
  const records = items.map(({ name: _name, code: _code, state: _state, probation: _probation, ...record }) => record);
  const trimmed = (await trimEmploymentResponse(deps, ctx, records)) as object[];
  return trimmed.map((record, index) => {
    const { state, probation, name, code } = items[index]!;
    return { ...record, state, probation, ...pick(show.employee, { code, name }) };
  });
}
