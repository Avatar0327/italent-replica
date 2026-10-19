/**
 * 兼职路由（R2-T05 BE-7 PT-3b / PT-3c，设计 §4.1 / §6.3 / §7.2 / §13.1）：新增预览、直接新增、员工兼职列表、单条详情，
 * 以及编辑兼职（PATCH）与批量结束，PT-5 起加六视图（GET part-times?view=…）与详情的期限链 / 申请历史；申请入口见 request-routes.ts。写入只调内部服务
 * createPartTime / editPartTime / batchEndPartTimes，路由层不另写校验或写库逻辑。
 * 新增请求体 { partTimeType, startDate, endDate?, fields, customFields? }；回执 = 兼职记录读形状（开始日期沿用 effectiveDate 编码）。
 * 新建对象没有 revision，不要求 If-Match；编辑带 If-Match（底层业务头 revision）；批量结束不带 If-Match，逐条 revision。
 * 结果未知时以同一 Idempotency-Key 重放。
 */
import { withTenant } from '@italent/db';
import {
  PART_TIME_BUTTONS,
  PART_TIME_EXPIRING_DAYS,
  PART_TIME_SERVICE_TYPES,
  PART_TIME_VIEWS,
  partTimePermissionFields,
  tenantLocalDate,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantEnv } from '../../../tenant-context.js';
import { validIsoDate } from '../../org/read-model.js';
import { getModuleViewableFields } from '../../permission/module-access.js';
import {
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
} from '../context.js';
import type { EmploymentContext } from '../types.js';
import { getEmployee } from '../employees.js';
import { resolveDepartmentIds } from '../exit-queries.js';
import { customFields, normalizedUuid, presetFieldsSchema } from '../fields.js';
import { parse } from '../entry-routes.js';
import {
  loadPartTimeHistory,
  listPartTimeView,
  type PartTimeHistory,
  type PartTimeViewFilter,
  type PartTimeViewItem,
} from './queries.js';
import { listEmployeePartTimes, loadPartTime, partTimeNotFound, partTimeToday } from './read.js';
import {
  partTimeCreateGuard,
  partTimeWriteGuard,
  requirePartTimePreviewButton,
  requirePartTimeScope,
  requirePartTimeWriteAccess,
  type PartTimeWriteTarget,
} from './replay-guard.js';
import {
  batchEndPartTimes,
  createPartTime,
  editPartTime,
  previewPartTime,
  type CreatePartTimeInput,
} from './service.js';
import { PART_TIME_FIELD_KEYS, normalizeBatchEnd, type EditPartTimeInput } from './validation.js';

export const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
/**
 * 兼职表单可填的预置字段（§4.2）：沿用任职预置字段的校验，部门必填；isDepartmentHead / addedSubordinateIds 先接收，
 * PT-7 之前由服务层拒绝 true / 非空（§4.8，400 PART_TIME_LINKAGE_NOT_AVAILABLE），不静默丢弃。
 */
const partTimeFields = presetFieldsSchema
  .pick({
    positionId: true,
    postId: true,
    levelId: true,
    sequenceId: true,
    directManagerId: true,
    dottedManagerId: true,
    employmentForm: true,
    employmentType: true,
    isDepartmentHead: true,
    addedSubordinateIds: true,
  })
  .extend({ departmentId: normalizedUuid });
export const createSchema = z.strictObject({
  partTimeType: z.enum(PART_TIME_SERVICE_TYPES),
  startDate: date,
  endDate: date.nullable().optional(),
  fields: partTimeFields,
  customFields: customFields.default({}),
});
type CreateBody = z.infer<typeof createSchema>;

/** 请求体 → 内部服务入参；显式 null 与缺省不同（预览带出默认值时显式 null 表示不要），所以按“自有键”搬运。 */
export function serviceInput(employeeId: string, body: CreateBody): CreatePartTimeInput {
  const fields = body.fields as Record<string, unknown>;
  const optional = Object.fromEntries(
    [...PART_TIME_FIELD_KEYS, 'isDepartmentHead', 'addedSubordinateIds']
      .filter((key) => Object.hasOwn(fields, key))
      .map((key) => [key, fields[key]]),
  );
  return {
    ...optional,
    employeeId,
    serviceType: body.partTimeType,
    startDate: body.startDate,
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    departmentId: body.fields.departmentId,
    customFields: body.customFields,
  };
}

/** 字段权限判定的载荷：实际写入的字段，开始日期按任职记录的 effectiveDate 编码判（startDate 不是任职记录字段）。 */
export function writeBusiness(body: CreateBody) {
  return {
    ...partTimePermissionFields({
      partTimeType: body.partTimeType,
      startDate: body.startDate,
      ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    }),
    fields: body.fields,
    customFields: body.customFields,
  };
}

/** 编辑（PATCH）入参：只给要改的键；开始日期 / 兼职类型只为拒绝改动而接收（§5.1，A-9）。 */
export const editSchema = z.strictObject({
  endDate: date.nullable().optional(),
  startDate: date.optional(),
  partTimeType: z.enum(PART_TIME_SERVICE_TYPES).optional(),
  fields: partTimeFields.partial().optional(),
  customFields: customFields.optional(),
});
type EditBody = z.infer<typeof editSchema>;

export function editInput(body: EditBody): EditPartTimeInput {
  const fields = (body.fields ?? {}) as Record<string, unknown>;
  const given = [...PART_TIME_FIELD_KEYS, 'departmentId', 'isDepartmentHead', 'addedSubordinateIds']
    .filter((key) => Object.hasOwn(fields, key))
    .map((key) => [key, fields[key]]);
  return {
    ...Object.fromEntries(given),
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
    ...(body.partTimeType !== undefined ? { serviceType: body.partTimeType } : {}),
    ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
  };
}

/** 字段权限判定的载荷：实际给出的键（开始日期按任职记录的 effectiveDate 编码判）。 */
export function editBusiness(body: EditBody) {
  return {
    ...partTimePermissionFields({
      ...(body.partTimeType !== undefined ? { partTimeType: body.partTimeType } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    }),
    ...(body.fields ? { fields: body.fields } : {}),
    ...(body.customFields ? { customFields: body.customFields } : {}),
  };
}

export function registerPartTimeRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerCreate(router, deps);
  registerEdit(router, deps);
  registerReads(router, deps);
}

/** 写回执 = 兼职记录读形状 + warnings；写入后读不到只可能是存储异常。 */
async function receipt(tx: Parameters<typeof loadPartTime>[0], context: EmploymentContext, id: string) {
  const record = await loadPartTime(tx, context, id);
  if (!record) throw new AppError('SERVICE_UNAVAILABLE', '兼职记录写入后不可读');
  return record;
}

function registerCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 预览：员工范围（readContext 带员工，范围外 404）+ 新增权 + 字段创建权 + 新增兼职 / 新增兼职申请任一按钮 + 兼职部门范围；
  // 只读，与新增同一套校验后带出默认值
  router.post('/employees/:id/part-times/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', 0, id);
    const body = parse(createSchema, await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', writeBusiness(body));
    await requirePartTimePreviewButton(deps, ctx);
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeScope(tx, ctx, id, body.fields.departmentId));
    const preview = await withTenant(deps.db, ctx.tenantId, (tx) => previewPartTime(tx, ctx, serviceInput(id, body)));
    const { warnings, ...rest } = preview;
    return c.json(
      await trimEmploymentResponse(deps, ctx, { ...rest, warnings: warnings.map((reason) => ({ reason })) }),
    );
  });
  // 直接新增：保存即落地（§2.3 / §2.4）；命令内 partTimeCreateGuard 按当前授权重过入口同一口径（重放 / 回查三个出口）
  router.post('/employees/:id/part-times', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', 0, id);
    const body = parse(createSchema, await jsonBody(c));
    const business = writeBusiness(body);
    await requireEmploymentWrite(ctx, 'create', business, PART_TIME_BUTTONS.direct);
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeScope(tx, ctx, id, body.fields.departmentId));
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'part-time-create', input: body },
      async (tx, context) => {
        const created = await createPartTime(tx, context, serviceInput(id, body));
        const record = await receipt(tx, context, created.id);
        return { status: 201, body: { ...record, warnings: created.warnings.map((reason) => ({ reason })) } };
      },
      { guard: partTimeCreateGuard(deps, ctx, { employeeId: id, business, departmentId: body.fields.departmentId }) },
    );
  });
}

function registerEdit(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 编辑兼职（§5.1 + 直接修改结束日期）：If-Match = 底层业务头 revision；入口先校验目标存在与范围（404）再判字段 / 按钮权（403），
  // 命令内 partTimeWriteGuard 在三个出口按当前授权重过；不触发向后更新（AC-FWD-11）
  router.patch('/part-times/:recordId', async (c) => {
    const id = uuidParam(c, 'recordId');
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const body = parse(editSchema, await jsonBody(c));
    const target: PartTimeWriteTarget = {
      recordIds: [id],
      business: editBusiness(body),
      button: PART_TIME_BUTTONS.edit,
      ...(body.fields?.departmentId ? { departmentId: body.fields.departmentId } : {}),
    };
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeWriteAccess(tx, ctx, target));
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'part-time-edit', input: body },
      async (tx, context) => {
        const edited = await editPartTime(tx, context, id, editInput(body));
        const record = await receipt(tx, context, id);
        return { status: 200, body: { ...record, warnings: edited.warnings.map((reason) => ({ reason })) } };
      },
      { guard: partTimeWriteGuard(deps, ctx, target) },
    );
  });
  // 批量结束（R2d）：不使用 If-Match（单个版本号无法对应多条记录），逐条 revision 在锁内比对；整批成功或整批失败
  router.post('/part-times/batch-end', async (c) => {
    const ctx = await readContext(c, deps, 'object.update');
    if (c.req.header('if-match') !== undefined)
      throw new AppError('VALIDATION_FAILED', '批量结束不使用 If-Match，请在每条里带 revision');
    const input = normalizeBatchEnd(await jsonBody(c));
    const target: PartTimeWriteTarget = {
      recordIds: input.items.map((item) => item.recordId),
      business: { endDate: input.endDate },
      button: PART_TIME_BUTTONS.batchEnd,
    };
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeWriteAccess(tx, ctx, target));
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'part-time-batch-end', input },
      async (tx, context) => {
        const done = await batchEndPartTimes(tx, context, input);
        const items = [];
        for (const recordId of done.recordIds) items.push(await receipt(tx, context, recordId));
        return {
          status: 200,
          body: { total: done.total, succeeded: done.total, failed: 0, batchId: done.batchId, items },
        };
      },
      { guard: partTimeWriteGuard(deps, ctx, target) },
    );
  });
}

function registerReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 员工“兼职记录”页签（B69 前端片）：DEC-177 可见（兼职部门 ∪ 员工当前主职部门）逐条裁剪，分页前过滤；
  // 一条都不可见时按员工是否对操作人可见决定 404 / 空列表，不暴露范围外员工是否存在
  router.get('/employees/:id/part-times', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: id });
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await listEmployeePartTimes(tx, ctx, id, page);
      if (!rows.length && page.offset === 0)
        await getEmployee(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone), ctx.scope);
      return rows;
    });
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  // 六视图（B25～B30，§6.1）：view 缺失 / 不合法 400，不回退到 all；readPageContext(list)；筛选用到的字段不可查看 403；分页前按 DEC-177
  // 过滤，total 与本页同一份结果；姓名 / 工号按人员对象、其余按任职记录对象的可见字段裁剪
  router.get('/part-times', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const { view, days, departmentId, includeChildren, ...rest } = parseViewQuery(c);
    const page = pageQuery(c);
    const filter: PartTimeViewFilter = rest;
    const show = await viewableIn(deps, ctx);
    requireViewableFilters({ ...filter, ...(departmentId ? { departmentIds: [departmentId] } : {}) }, show);
    const today = partTimeToday(ctx);
    const { items, total } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const departmentIds = departmentId
        ? await resolveDepartmentIds(tx, ctx.tenantId, departmentId, includeChildren !== 'false', today)
        : undefined;
      const scoped = { ...filter, ...(departmentIds ? { departmentIds } : {}) };
      return listPartTimeView(tx, ctx, { view, days: days ?? PART_TIME_EXPIRING_DAYS.default, page, filter: scoped });
    });
    return c.json({
      items: await trimViewItems(deps, ctx, items, show),
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  // 兼职详情（B32）：当前字段 + 期限链 + 申请历史。范围外与不存在同一个 404；期限链随结束日期字段权，申请历史逐条按 §6.2 可见与字段权裁剪
  router.get('/part-times/:recordId', async (c) => {
    const recordId = uuidParam(c, 'recordId');
    const ctx = await readPageContext(c, deps, 'detail');
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const record = await loadPartTime(tx, ctx, recordId);
      return record && { record, history: await loadPartTimeHistory(tx, ctx, recordId) };
    });
    if (!found) throw partTimeNotFound();
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'tenant.employment.read',
      resource: found.record.employeeId,
    });
    return c.json({
      ...((await trimEmploymentResponse(deps, ctx, found.record)) as object),
      ...(await trimHistory(deps, ctx, found.history)),
    });
  });
}

// ---- 六视图的查询参数、筛选字段权与响应裁剪 ---------------------------------------------------------------------------

const enabledQuery = z.enum(['true', 'false']).optional();
const viewQuery = z.object({
  view: z.enum(PART_TIME_VIEWS),
  days: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(PART_TIME_EXPIRING_DAYS.min).max(PART_TIME_EXPIRING_DAYS.max))
    .optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
  departmentId: normalizedUuid.optional(),
  includeChildren: enabledQuery,
  serviceType: z.enum(PART_TIME_SERVICE_TYPES).optional(),
  startFrom: date.optional(),
  startTo: date.optional(),
  endFrom: date.optional(),
  endTo: date.optional(),
  directManagerId: normalizedUuid.optional(),
});
const VIEW_QUERY_KEYS = Object.keys(viewQuery.shape);

/** 日期区间首尾颠倒按非法处理（400）。 */
function parseViewQuery(c: Context<TenantEnv>) {
  const query = parse(viewQuery, Object.fromEntries(VIEW_QUERY_KEYS.map((key) => [key, c.req.query(key)])));
  if (query.startFrom && query.startTo && query.startFrom > query.startTo)
    throw new AppError('VALIDATION_FAILED', '开始日期区间的起止日期颠倒');
  if (query.endFrom && query.endTo && query.endFrom > query.endTo)
    throw new AppError('VALIDATION_FAILED', '结束日期区间的起止日期颠倒');
  return query;
}

/** 姓名 / 工号属人员对象，其余按任职记录对象；无字段权限配置 = 全可见（同离职 / 实习视图）。 */
async function viewableIn(deps: TenantRouteDeps, ctx: EmploymentContext) {
  const [employee, employment] = await Promise.all([
    getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT),
    getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT),
  ]);
  const has = (set: ReadonlySet<string> | undefined) => (field: string) => set === undefined || set.has(field);
  return { employee: has(employee), employment: has(employment) };
}
type Viewable = Awaited<ReturnType<typeof viewableIn>>;

/** 筛选 → 依赖的字段：按它筛选等于探测它的值，须先能看到（403，不让筛选成为探针）。 */
const FILTER_FIELDS: Readonly<Record<keyof PartTimeViewFilter, { employee?: string[]; employment?: string[] }>> = {
  keyword: { employee: ['name', 'code'] },
  departmentIds: { employment: ['departmentId'] },
  serviceType: { employment: ['serviceType'] },
  startFrom: { employment: ['effectiveDate'] },
  startTo: { employment: ['effectiveDate'] },
  endFrom: { employment: ['endDate'] },
  endTo: { employment: ['endDate'] },
  directManagerId: { employment: ['directManagerId'] },
};

function requireViewableFilters(filter: PartTimeViewFilter, show: Viewable) {
  const used = (Object.keys(FILTER_FIELDS) as (keyof PartTimeViewFilter)[]).filter((key) => filter[key] !== undefined);
  const hidden = used.some(
    (key) =>
      !(FILTER_FIELDS[key].employee ?? []).every(show.employee) ||
      !(FILTER_FIELDS[key].employment ?? []).every(show.employment),
  );
  if (hidden) throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

/** 行：任职字段按任职记录、姓名 / 工号按人员对象、主职部门按任职记录的部门字段裁剪（同类位置统一在这里）。 */
async function trimViewItems(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  items: readonly PartTimeViewItem[],
  show: Viewable,
) {
  const records = items.map(({ employee: _employee, primaryDepartmentId: _primary, ...record }) => record);
  const trimmed = (await trimEmploymentResponse(deps, ctx, records)) as object[];
  return trimmed.map((record, index) => {
    const { employee, primaryDepartmentId } = items[index]!;
    const person = Object.fromEntries(Object.entries(employee).filter(([field]) => show.employee(field)));
    return {
      ...record,
      ...(Object.keys(person).length ? { employee: person } : {}),
      ...(primaryDepartmentId !== undefined && show.employment('departmentId') ? { primaryDepartmentId } : {}),
    };
  });
}

/** 期限链记录结束日期的变更历史，跟随结束日期字段权（无权整个键缺席）；申请历史逐条经 trimEmploymentResponse。 */
async function trimHistory(deps: TenantRouteDeps, ctx: EmploymentContext, history: PartTimeHistory) {
  const show = await viewableIn(deps, ctx);
  return {
    ...(show.employment('endDate') ? { terms: history.terms } : {}),
    requests: await trimEmploymentResponse(deps, ctx, history.requests),
  };
}
