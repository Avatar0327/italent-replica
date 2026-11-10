/**
 * 兼职申请路由（R2-T05 BE-7 PT-4b / PT-4c，设计 §4.1 / §7.2 / §13.1）：三类申请（新增 / 延长 / 结束）的建（可直接提交）/ 读 / 改 /
 * 提交 / 撤回 / 撤销 / 删除。路由只做参数解析、权限与范围判定和重放守卫，业务一律调 request-service（PT-4a），审批实例的发起 /
 * 撤回 / 取消在服务里走审批中心既有入口；校验与新增兼职同一套（D-1～D-10、周期边界）、延长 / 结束同一套（E-1～E-6、T-1～T-4），
 * 不在这里另写一份。联动字段（PT-7，§4.8）：新增申请保存并校验 isDepartmentHead / addedSubordinateIds，审批通过落地才执行；
 * 延长 / 结束申请只改结束日期与备注，两字段 true / 非空 → 400 PART_TIME_FIELD_NOT_EDITABLE（服务层统一拒绝）。
 * 新增申请新建带 requestType = add、employeeId；延长 / 结束申请带 requestType、recordId（目标兼职）、endDate（新结束日期）、可选
 * requestRemark，权限按“编辑兼职”口径（对象更新权 + 延长 / 结束按钮 + 目标记录的兼职部门范围）；都可选 submit（建并提交一步到位，
 * 另要 Employment.Submit）。修改 / 动作带 If-Match（申请头 revision），按钮随申请类型。回执 = 申请读形状（request-read.ts）。
 */
import { withTenant } from '@italent/db';
import { PART_TIME_BUTTONS, PART_TIME_REMARK_MAX } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantEnv } from '../../../tenant-context.js';
import { LIVE_VIEW, openContentRead } from '../../approval/frozen-read.js';
import { foreignVisibility } from '../../approval/foreign-fields.js';
import type { FieldAccess } from '../../approval/context.js';
import { storedCeiling } from '../../approval/object-ceiling.js';
import {
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  trimModuleResponse,
} from '../../permission/module-access.js';
import {
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  jsonBody,
  readContext,
  readPageContext,
  revision,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
} from '../context.js';
import { parse } from '../entry-routes.js';
import { normalizedUuid } from '../fields.js';
import type { EmploymentContext } from '../types.js';
import {
  partTimeCreateGuard,
  partTimeRequestGuard,
  partTimeWriteGuard,
  requirePartTimeCreateAccess,
  requirePartTimeRequestAccess,
  requirePartTimeWriteAccess,
  type PartTimeRequestTarget,
  type PartTimeWriteTarget,
} from './replay-guard.js';
import { availableRequestActions, REQUEST_ACTION_ACCESS, requestActionTarget } from './request-actions.js';
import {
  loadPartTimeRequestDetail,
  loadRequestReceipt,
  type PartTimeContent,
  type PartTimeRequestDto,
} from './request-read.js';
import {
  createAddRequest,
  deleteRequest,
  notFound,
  revokeRequest,
  createDateRequest,
  submitRequest,
  updateRequest,
  withdrawRequest,
  type AddRequestInput,
  type AddRequestPatch,
  type DateRequestInput,
} from './request-service.js';
import { createSchema, date, editBusiness, editInput, editSchema, serviceInput, writeBusiness } from './routes.js';

const remark = z.string().max(PART_TIME_REMARK_MAX).nullable().optional();
/** 新增申请（requestType = add）请求体：新增兼职的字段（共用 createSchema）+ 员工 + 申请备注 + 是否建完直接提交。 */
const createRequestSchema = createSchema.extend({
  requestType: z.literal('add'),
  employeeId: normalizedUuid,
  requestRemark: remark,
  submit: z.boolean().optional(),
});
type CreateRequestBody = z.infer<typeof createRequestSchema>;
/** 延长 / 结束申请请求体：目标兼职记录 + 新结束日期（必填，不能置空）+ 备注；联动两字段只为统一拒绝而接收（PT-7 后仍不受理）。 */
const createDateRequestSchema = z.strictObject({
  requestType: z.enum(['extend', 'end']),
  recordId: normalizedUuid,
  endDate: date,
  requestRemark: remark,
  submit: z.boolean().optional(),
  isDepartmentHead: z.boolean().nullable().optional(),
  addedSubordinateIds: z.array(normalizedUuid).nullable().optional(),
});
type CreateDateBody = z.infer<typeof createDateRequestSchema>;
/** 修改草稿 / 驳回中的申请：只给要改的键（共用 editSchema）+ 申请备注。 */
const patchRequestSchema = editSchema.extend({ requestRemark: remark });
type PatchRequestBody = z.infer<typeof patchRequestSchema>;

const ACTIONS = { submit: submitRequest, withdraw: withdrawRequest, revoke: revokeRequest } as const;

/** 字段写权的载荷：新增兼职的字段 + 申请备注（requestRemark 是任职记录权限目录里的可授编辑字段）。 */
function createBusiness(body: CreateRequestBody) {
  return { ...writeBusiness(body), ...(body.requestRemark != null ? { requestRemark: body.requestRemark } : {}) };
}

function patchBusiness(body: PatchRequestBody) {
  return { ...editBusiness(body), ...(body.requestRemark !== undefined ? { requestRemark: body.requestRemark } : {}) };
}

/** 延长 / 结束申请的字段写权载荷：结束日期与备注（requestRemark 是任职记录权限目录里的可授编辑字段）。 */
function dateBusiness(body: CreateDateBody) {
  return { endDate: body.endDate, ...(body.requestRemark != null ? { requestRemark: body.requestRemark } : {}) };
}

function dateInput(body: CreateDateBody): DateRequestInput {
  return {
    requestType: body.requestType,
    recordId: body.recordId,
    endDate: body.endDate,
    remark: body.requestRemark ?? null,
    ...(body.isDepartmentHead !== undefined ? { isDepartmentHead: body.isDepartmentHead } : {}),
    ...(body.addedSubordinateIds !== undefined ? { addedSubordinateIds: body.addedSubordinateIds } : {}),
  };
}

function createInput(body: CreateRequestBody): AddRequestInput {
  return { ...serviceInput(body.employeeId, body), remark: body.requestRemark ?? null };
}

/** editSchema 保证 departmentId 非空（只能改成另一个部门，不能清空）；EditPartTimeInput 的类型更宽，这里收窄。 */
function patchInput(body: PatchRequestBody): AddRequestPatch {
  return {
    ...editInput(body),
    ...(body.requestRemark !== undefined ? { remark: body.requestRemark } : {}),
  } as AddRequestPatch;
}

/**
 * 提交时审批中心按候选审批人的字段查看权做盲审（DEC-058）：与 approval/routes.ts 的 fieldAccess 同口径（各模块自带，不 import
 * 审批路由）；未注入的字段按看不到处理（fail-closed）。
 */
function approvalFields(deps: TenantRouteDeps, ctx: EmploymentContext): FieldAccess {
  return {
    viewable: (tx, userId, objectCode) =>
      getModuleViewableFieldsInTransaction(deps, { ...ctx, userId }, objectCode, tx),
    foreignVisible: (tx, userId, field) => foreignVisibility(deps, { ...ctx, userId }, tx)(field),
  };
}

export function registerPartTimeRequestRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerRequestCreate(router, deps);
  registerRequestChanges(router, deps);
  registerRequestRead(router, deps);
}

/** 写回执 = 申请读形状 + warnings；写入后读不到只可能是存储异常。 */
async function receipt(
  tx: Parameters<typeof loadRequestReceipt>[0],
  context: EmploymentContext,
  id: string,
  warnings: readonly string[] = [],
) {
  const dto = await loadRequestReceipt(tx, context, id, warnings);
  if (!dto) throw new AppError('SERVICE_UNAVAILABLE', '兼职申请写入后不可读');
  return dto;
}

function registerRequestCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 新建（建草稿，或 submit = true 建完直接提交）：object.create + 新增兼职申请按钮（建并提交另要 Employment.Submit）+ 员工主职与兼职
  // 部门范围 + 字段创建权；命令内 partTimeCreateGuard 三个出口按当前授权重过。建 + 提交同一事务：没有匹配的流程 / 首节点无人时整单回滚
  router.post('/part-time-requests', async (c) => {
    if (await isDateRequestBody(c)) return createDateRequestRoute(c, deps);
    const ctx = await readContext(c, deps, 'object.create');
    const body = parse(createRequestSchema, await jsonBody(c));
    const target = {
      employeeId: body.employeeId,
      business: createBusiness(body),
      departmentId: body.fields.departmentId,
      buttons: body.submit ? REQUEST_ACTION_ACCESS.submit.buttons : REQUEST_ACTION_ACCESS.edit.buttons,
    };
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeCreateAccess(tx, ctx, target));
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'part-time-request-create', input: body },
      async (tx, context) => {
        const created = await createAddRequest(tx, context, createInput(body));
        const done = body.submit
          ? await submitRequest(
              tx,
              { ...context, expectedRevision: created.revision },
              created.id,
              approvalFields(deps, ctx),
            )
          : created;
        return { status: 201, body: await receipt(tx, context, done.id, done.warnings) };
      },
      { guard: partTimeCreateGuard(deps, ctx, target) },
    );
  });
}

/** 请求体的 requestType 是不是延长 / 结束（只看这一个键，读不了或不是对象都当新增，由新增入口的严格校验给 400）。 */
async function isDateRequestBody(c: Context<TenantEnv>): Promise<boolean> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const type = (raw as { requestType?: unknown } | null | undefined)?.requestType;
  return type === 'extend' || type === 'end';
}

const DATE_BUTTONS = { extend: PART_TIME_BUTTONS.extend, end: PART_TIME_BUTTONS.end } as const;

/**
 * 延长 / 结束申请的新建（建草稿，或 submit = true 建完直接提交）：object.update + 延长 / 结束按钮（建并提交另要 Employment.Submit）+
 * 目标兼职记录的兼职部门范围（同编辑兼职，范围外与不存在同一个 404）+ endDate / requestRemark 字段写权；命令内 partTimeWriteGuard
 * 三个出口按当前授权重过；锁内 E-1～E-6 / T-1～T-4 由 createDateRequest 判，通过才写。建 + 提交同一事务。
 */
async function createDateRequestRoute(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await readContext(c, deps, 'object.update');
  const body = parse(createDateRequestSchema, await jsonBody(c));
  const target: PartTimeWriteTarget = {
    recordIds: [body.recordId],
    business: dateBusiness(body),
    button: DATE_BUTTONS[body.requestType],
    ...(body.submit ? { extraButtons: ['Employment.Submit'] } : {}),
  };
  await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeWriteAccess(tx, ctx, target));
  return runWrite(
    c,
    deps,
    ctx,
    { action: 'part-time-request-create', input: body },
    async (tx, context) => {
      const created = await createDateRequest(tx, context, dateInput(body));
      const done = body.submit
        ? await submitRequest(
            tx,
            { ...context, expectedRevision: created.revision },
            created.id,
            approvalFields(deps, ctx),
          )
        : created;
      return { status: 201, body: await receipt(tx, context, done.id, done.warnings) };
    },
    { guard: partTimeWriteGuard(deps, ctx, target) },
  );
}

function registerRequestChanges(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 修改草稿 / 驳回中的申请：If-Match = 申请头 revision；入口先校验申请存在与范围（404）再判字段 / 按钮权（403）；
  // 命令内 partTimeRequestGuard 重过；锁内 revision / 状态 / D-1～D-10 / E-1～E-6 / T-1～T-2 与周期边界由 updateRequest 判，越界当次拒绝不留版本
  router.patch('/part-time-requests/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const body = parse(patchRequestSchema, await jsonBody(c));
    const target: PartTimeRequestTarget = {
      requestId: id,
      operation: 'update',
      business: patchBusiness(body),
      buttons: REQUEST_ACTION_ACCESS.edit.buttons,
      ...(body.fields?.departmentId ? { departmentId: body.fields.departmentId } : {}),
    };
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeRequestAccess(tx, ctx, target));
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'part-time-request-update', input: body },
      async (tx, context) => {
        const updated = await updateRequest(tx, context, id, patchInput(body));
        return { status: 200, body: await receipt(tx, context, id, updated.warnings) };
      },
      { guard: partTimeRequestGuard(deps, ctx, target) },
    );
  });
  // 提交 / 撤回（只允许原发起人，锁内判）/ HR 撤销：If-Match = 申请头 revision，不读请求体
  for (const action of ['submit', 'withdraw', 'revoke'] as const)
    router.post(`/part-time-requests/:id/${action}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      const target = requestActionTarget(id, action);
      await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeRequestAccess(tx, ctx, target));
      return runWrite(
        c,
        deps,
        ctx,
        { id, action: `part-time-request-${action}` },
        async (tx, context) => {
          const done =
            action === 'submit'
              ? await submitRequest(tx, context, id, approvalFields(deps, ctx))
              : await ACTIONS[action](tx, context, id);
          return { status: 200, body: await receipt(tx, context, id, done.warnings) };
        },
        { guard: partTimeRequestGuard(deps, ctx, target) },
      );
    });
  // 删除草稿 / 驳回中的申请（保留快照，状态置 deleted）：object.delete + 新增兼职申请 + Employment.Delete
  router.delete('/part-time-requests/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.delete', revision(c));
    const target = requestActionTarget(id, 'delete');
    await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeRequestAccess(tx, ctx, target));
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'part-time-request-delete' },
      async (tx, context) => {
        await deleteRequest(tx, context, id);
        return { status: 200, body: await receipt(tx, context, id) };
      },
      { guard: partTimeRequestGuard(deps, ctx, target) },
    );
  });
}

function registerRequestRead(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 申请详情（含主职信息 / 员工信息分组，读员工当前主职）：DEC-177 可见（申请部门 ∪ 员工当前主职部门）；范围外与不存在同一个 404；
  // 主职分组只在操作人看得到该主职记录时给出；三组各按所属对象的字段查看权逐层裁剪。
  // F-476 P5：已办人读办理时冻结的申请内容（不套数据范围，DEC-834④）：申请内容按完整披露集（办理上限 ∩ 办理节点表单 ∩
  // 当前字段权）逐层裁；主职 / 员工分组是办理时冻结的展示材料，主职（记录 ID 与 fields，R4 P2-1）按任职对象办理上限、
  // 员工按员工对象办理上限（R2 P1），再按当前字段权裁（R1 P2-3）；其余人读现值。
  router.get('/part-time-requests/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const read = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const content = await openContentRead<PartTimeContent>(tx, deps, ctx, 'part_time', id, EMPLOYMENT_OBJECT);
      if (content?.frozen) {
        return {
          frozen: content.frozen.ext,
          ceiling: content.ceiling,
          fields: content.fields,
          view: content.contentView,
        };
      }
      return { detail: await loadPartTimeRequestDetail(tx, ctx, id), view: content?.contentView ?? LIVE_VIEW };
    });
    if (read.frozen) {
      const { primary, employee, employeeCeiling, ...request } = read.frozen;
      const cappedPrimary = primary && capPrimary(primary, read.ceiling);
      const cappedEmployee = keepIn(employee, storedCeiling(employeeCeiling));
      return c.json({
        ...(await trimRequestDto(deps, ctx, capByDisclosed(request, read.ceiling, read.fields))),
        availableActions: [],
        primary: cappedPrimary ? await trimEmploymentResponse(deps, ctx, cappedPrimary) : null,
        employee: await trimModuleResponse(deps, ctx, EMPLOYEE_OBJECT, cappedEmployee),
        contentView: read.view,
      });
    }
    const detail = read.detail;
    if (!detail) throw notFound();
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: detail.employeeId });
    const { primary, employee, ...request } = detail;
    const trimmed = await trimRequestDto(deps, ctx, request);
    return c.json({
      ...trimmed,
      // F-268：逐单可用动作（写入口同一组判定，request-actions.ts）；状态字段对当前操作人不可见时不下发，避免动作集合泄露状态
      availableActions: 'status' in trimmed ? await availableRequestActions(c, deps, ctx.tenantId, id) : [],
      primary: primary ? await trimEmploymentResponse(deps, ctx, primary) : null,
      employee: await trimModuleResponse(deps, ctx, EMPLOYEE_OBJECT, employee),
      contentView: read.view,
    });
  });
}

/**
 * 申请 DTO 的最终投影（R2 P2-3）：任职类型在 DTO 里叫 serviceType，在字段权限 / 节点表单里叫 partTimeType（与审批中心、
 * 自助申请 application-access.ts 同一编码），按后者判权；其余键交 trimEmploymentResponse。
 */
async function trimRequestDto(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  request: object,
): Promise<Record<string, unknown>> {
  const { serviceType, ...rest } = request as Record<string, unknown>;
  const trimmed = (await trimEmploymentResponse(deps, ctx, rest)) as Record<string, unknown>;
  if (!Object.hasOwn(request, 'serviceType')) return trimmed;
  const viewable = await getModuleViewableFields(deps, ctx, ctx.objectCode ?? EMPLOYMENT_OBJECT);
  return !viewable || viewable.has(formCode('serviceType')) ? { ...trimmed, serviceType } : trimmed;
}

/** 申请 DTO 里属于「申请表单业务字段」的顶层键；其余顶层键（id、状态、版本号等）只受办理上限约束。 */
const FORM_TOP_KEYS = new Set(['serviceType', 'effectiveDate', 'endDate', 'originalEndDate', 'requestRemark']);
/** DTO 键 → 字段权限 / 节点表单编码（服务类型在权限里叫 partTimeType，开始日期的 DTO 键已是 effectiveDate）。 */
const formCode = (key: string) => (key === 'serviceType' ? 'partTimeType' : key);

const keepIn = <T extends object>(
  source: T,
  allowed: ReadonlySet<string> | null | undefined,
  name = (k: string) => k,
): T => (allowed ? Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(name(key)))) : source) as T;

/**
 * 冻结的主职分组按任职对象办理上限截（R4 P2-1）：记录 ID 等分组元数据键与 fields 内各字段同一道上限，
 * 之后再由 trimEmploymentResponse 按当前字段权裁；不能只截 fields、让 id 只经过当前字段权（设计 §5.2）。
 */
function capPrimary(primary: NonNullable<PartTimeContent['primary']>, ceiling: ReadonlySet<string> | null) {
  const { fields, ...meta } = primary;
  return { ...keepIn(meta, ceiling), fields: keepIn(fields, ceiling) };
}

/**
 * 办理份申请内容按披露集逐层截（F-476 P5 R1 P1-1）：顶层表单键、`fields`、`customFields` 用完整披露集
 * （办理上限 ∩ 节点表单 ∩ 当前字段权），非表单顶层键只按办理上限；披露集 undefined = 不受字段权限约束。
 */
function capByDisclosed(
  dto: PartTimeRequestDto,
  ceiling: ReadonlySet<string> | null,
  disclosed: ReadonlySet<string> | undefined,
): PartTimeRequestDto {
  const top = Object.fromEntries(
    Object.entries(dto).filter(([key]) =>
      FORM_TOP_KEYS.has(key) ? !disclosed || disclosed.has(formCode(key)) : !ceiling || ceiling.has(key),
    ),
  );
  return {
    ...top,
    fields: keepIn(dto.fields, disclosed),
    customFields: keepIn(dto.customFields, disclosed, (id) => `custom:${id}`),
  } as PartTimeRequestDto;
}
