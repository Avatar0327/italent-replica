/**
 * 兼职路由（R2-T05 BE-7 PT-3b，设计 §4.1 / §6.3 / §7.2 / §13.1）：新增预览、直接新增、员工兼职列表、单条详情；
 * 编辑、批量结束、六视图、申请入口由后续批次开放（此处不注册，404）。新增只调内部服务 createPartTime，路由层不另写校验或写库逻辑。
 * 请求体 { partTimeType, startDate, endDate?, fields, customFields? }；回执 = 兼职记录读形状（开始日期沿用 effectiveDate 编码）。
 * 新建对象没有 revision，不要求 If-Match；结果未知时以同一 Idempotency-Key 重放。
 */
import { withTenant } from '@italent/db';
import { PART_TIME_BUTTONS, PART_TIME_SERVICE_TYPES, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantEnv } from '../../../tenant-context.js';
import { validIsoDate } from '../../org/read-model.js';
import {
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmploymentScope,
  requireEmploymentWrite,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
} from '../context.js';
import { getEmployee } from '../employees.js';
import { customFields, normalizedUuid, presetFieldsSchema } from '../fields.js';
import { parse } from '../entry-routes.js';
import { listEmployeePartTimes, loadPartTime, partTimeNotFound } from './read.js';
import { partTimeCreateGuard, requirePartTimePreviewButton } from './replay-guard.js';
import { createPartTime, previewPartTime, type CreatePartTimeInput } from './service.js';
import { PART_TIME_FIELD_KEYS } from './validation.js';

const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
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
const createSchema = z.strictObject({
  partTimeType: z.enum(PART_TIME_SERVICE_TYPES),
  startDate: date,
  endDate: date.nullable().optional(),
  fields: partTimeFields,
  customFields: customFields.default({}),
});
type CreateBody = z.infer<typeof createSchema>;

/** 请求体 → 内部服务入参；显式 null 与缺省不同（预览带出默认值时显式 null 表示不要），所以按“自有键”搬运。 */
function serviceInput(employeeId: string, body: CreateBody): CreatePartTimeInput {
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
function writeBusiness(body: CreateBody) {
  return {
    partTimeType: body.partTimeType,
    effectiveDate: body.startDate,
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    fields: body.fields,
    customFields: body.customFields,
  };
}

export function registerPartTimeRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerCreate(router, deps);
  registerReads(router, deps);
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
    requireEmploymentScope(ctx, id, body.fields.departmentId);
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
    requireEmploymentScope(ctx, id, body.fields.departmentId);
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'part-time-create', input: body },
      async (tx, context) => {
        const created = await createPartTime(tx, context, serviceInput(id, body));
        const record = await loadPartTime(tx, context, created.id);
        if (!record) throw new AppError('SERVICE_UNAVAILABLE', '兼职记录写入后不可读');
        return { status: 201, body: { ...record, warnings: created.warnings.map((reason) => ({ reason })) } };
      },
      { guard: partTimeCreateGuard(deps, ctx, { employeeId: id, business, departmentId: body.fields.departmentId }) },
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
  // 兼职详情（B32 当前字段；期限链与申请历史随 PT-5）：范围外与不存在同一个 404
  router.get('/part-times/:recordId', async (c) => {
    const recordId = uuidParam(c, 'recordId');
    const ctx = await readPageContext(c, deps, 'detail');
    const record = await withTenant(deps.db, ctx.tenantId, (tx) => loadPartTime(tx, ctx, recordId));
    if (!record) throw partTimeNotFound();
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: record.employeeId });
    return c.json(await trimEmploymentResponse(deps, ctx, record));
  });
}
