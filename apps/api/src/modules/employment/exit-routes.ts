/**
 * R2-T03 离职路由（挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts，设计 §4 / §9.2）。
 * 三个字典（B1a）：读取对持任职记录查看权者开放（表单下拉、列表显示名称），写入是配置对象
 * （tenant.employment.configuration.write，管理员 other_settings；字段按任职设置配置对象校验）。
 * 办理入口（B2b）：预览 / 新建 / 批量 / 编辑离职 / 提交 / 撤回。权限链按 §9.1 固定顺序：功能操作权（readContext）→
 * 按钮权 → 范围（范围外 404）→ 字段权 → §4A 前置条件；写入口的按钮、范围、字段在命令事务内按当前授权复核
 * （exitCommandGuard / exitBatchGuard，#199），重放与失败回查同样经过。E ≤ 今天的直接离职在保存事务内生效（§5.3）。
 */
import {
  buttonResource,
  buttonsOf,
  EXIT_BUTTONS,
  EXIT_SETTING_KEYS,
  EXIT_SETTINGS,
  tenantLocalDate,
} from '@italent/domain';
import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmployeeInScope,
  requireEmploymentScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { createExitApplication, parseExitPatch, updateExitFields } from './exit-application.js';
import {
  cancelExit,
  cancellationOwner,
  exitKindLabel,
  rejectRestore,
  updateCancellationReason,
} from './exit-cancel.js';
import { trimDownstream, type Downstream } from './exit-downstream.js';
import { createExitBatch, EXIT_BATCH_LIMIT, submitExit } from './exit-batch.js';
import { businessKind, loadExitRequest, requireExitPermission } from './exit-gate.js';
import { exitOptionsSchema, splitExitOptions } from './exit-initiation.js';
import {
  EXIT_INITIATIONS,
  EXIT_STATES,
  EXIT_VIEWS,
  filterFieldsOf,
  listExitView,
  loadExitDetail,
  resolveDepartmentIds,
  trimExit,
  trimExitDetail,
  type ExitViewable,
  type ExitViewFilter,
} from './exit-queries.js';
import { previewExit } from './exit-preview.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import { businessDate, normalizeEmploymentInput, normalizedUuid } from './fields.js';
import type { BusinessWriteGuard } from './entry-routes.js';
import { exitBatchGuard, exitCommandGuard, exitEditGuard } from './replay-guard.js';
import { loadEmploymentBusiness } from './read-model.js';
import { transitionEmployment } from './transitions.js';
import {
  exitDictionaryKind,
  listExitDictionary,
  parseExitDictionaryInput,
  saveExitDictionaryEntry,
} from './exit-dictionaries.js';

// §2.2 转交时机配置项的取值校验（两层配置写入口，非法值 400 SETTING_VALUE_INVALID）
for (const key of EXIT_SETTING_KEYS) registerSettingValidator(key, EXIT_SETTINGS[key].valid);

const enabledQuery = z.enum(['true', 'false']).optional();

export function registerExitRoutes(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  registerExitDictionaries(router, deps);
  registerExitViews(router, deps);
  registerExitCreate(router, deps);
  registerExitChanges(router, deps, authorizeBusinessWrite);
  registerExitCancel(router, deps, authorizeBusinessWrite);
}

function registerExitDictionaries(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/exits/dictionaries/:dict', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0);
    const kind = exitDictionaryKind(c.req.param('dict'));
    const enabled = enabledQuery.safeParse(c.req.query('enabled'));
    if (!enabled.success) throw new AppError('VALIDATION_FAILED', 'enabled 只能为 true 或 false');
    const filter = enabled.data === undefined ? {} : { enabled: enabled.data === 'true' };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listExitDictionary(tx, ctx.tenantId, kind, filter));
    return c.json({ items });
  });
  router.post('/exits/dictionaries/:dict', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const kind = exitDictionaryKind(c.req.param('dict'));
    const input = parseExitDictionaryInput(await jsonBody(c), 'create');
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, { kind, input }, async (tx, context) => ({
      status: 201,
      body: await saveExitDictionaryEntry(tx, context, kind, input),
    }));
  });
  router.put('/exits/dictionaries/:dict/:id', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const kind = exitDictionaryKind(c.req.param('dict'));
    const id = uuidParam(c);
    const input = parseExitDictionaryInput(await jsonBody(c), 'update');
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, { kind, id, input }, async (tx, context) => ({
      status: 200,
      body: await saveExitDictionaryEntry(tx, context, kind, input, id),
    }));
  });
}

/** 业务日期（YYYY-MM-DD 且为真实日期）。 */
export const day = z.string().refine((value) => {
  try {
    return businessDate(value) === value;
  } catch {
    return false;
  }
}, '日期不合法');

export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', result.error.issues);
  return result.data;
};

/** 预览：直接 / 申请两个按钮任一即可（§4A preview 行，功能权是 object.view）；两项都无 → 403。退休取 Retire* 两个按钮。 */
export async function requirePreviewButton(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  kind: 'leave' | 'retirement' = 'leave',
) {
  const buttons = buttonsOf(kind);
  const held = async (code: string) =>
    deps.authorize({ ...ctx, action: 'object.button', resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail') });
  if (!(await held(buttons.direct)) && !(await held(buttons.application)))
    throw new AppError('FORBIDDEN', kind === 'retirement' ? '没有退休办理权限' : '没有离职办理权限');
}

/** 专用新建入口的请求体：任职业务输入（kind 由入口固定，不接受 kind）+ exit 区块（§4B 字段）。 */
export function parseExitCreate(ctx: EmploymentContext, body: unknown, kind: 'leave' | 'retirement' = 'leave') {
  const { rawInput, exit } = splitExitOptions(body);
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput) || 'kind' in rawInput)
    throw new AppError('VALIDATION_FAILED', '离职 / 退休入口不接受业务类型参数');
  const raw = rawInput as Record<string, unknown>;
  const input = normalizeEmploymentInput(ctx, { fields: {}, ...raw, kind });
  return {
    mode: input.mode,
    lastWorkDate: input.lastWorkDate!,
    ...(raw.effectiveDate === undefined ? {} : { effectiveDate: input.effectiveDate }),
    ...(input.formId && raw.formId !== undefined ? { formId: input.formId } : {}),
    fields: input.fields,
    customFields: input.customFields,
    exit,
  };
}

function registerExitCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 预览：员工范围（readContext 带员工，范围外 404）+ Dimission / DimissionApproval；只读，清单逐项按可见性披露
  router.post('/exits/employees/:id/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view', 0, id);
    const { lastWorkDate } = parse(z.strictObject({ lastWorkDate: day }), await jsonBody(c));
    await requirePreviewButton(deps, ctx);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => previewExit(tx, ctx, id, lastWorkDate)));
  });
  // 新建（HR 端，离职申请 / 直接离职）：与通用入口同一申请服务与门禁；不要求 Employment.Create
  router.post('/exits/employees/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const input = parseExitCreate(ctx, await jsonBody(c));
    const departmentId = input.fields.departmentId;
    if (departmentId !== undefined) requireEmploymentScope(ctx, id, departmentId);
    const gate = {
      employeeId: id,
      initiation: 'hr' as const,
      mode: input.mode,
      lastWorkDate: input.lastWorkDate,
      exit: input.exit,
      payload: { fields: input.fields, customFields: input.customFields },
    };
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({
        status: 201,
        body: await createExitApplication(tx, context, { ...input, employeeId: id, initiation: 'hr' }),
      }),
      { guard: exitCommandGuard(deps, ctx, 'create', gate, { departmentId }) },
    );
  });
  router.post('/exits/batch', async (c) => {
    const ctx = await readContext(c, deps, 'object.create');
    const { items } = parse(batchSchema, await jsonBody(c));
    const guard = exitBatchGuard(deps, ctx, items);
    return runWrite(
      c,
      deps,
      ctx,
      { items },
      async (tx, context) => ({ status: 201, body: await createExitBatch(tx, context, items, guard.failures()) }),
      { guard },
    );
  });
}

const batchSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        employeeId: normalizedUuid,
        revision: z.int().nonnegative(),
        lastWorkDate: day,
        exit: exitOptionsSchema.optional(),
      }),
    )
    .min(1)
    .max(EXIT_BATCH_LIMIT),
});

/** 离职单（有扩展行的 kind=leave）才走离职入口，调动等其他单 404（退休入口同理，kind=retirement）；范围由 authorizeBusinessWrite 先判（写入口径 404）。 */
export async function requireExitBusiness(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  kind: 'leave' | 'retirement' = 'leave',
) {
  await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const exit = await loadExitRequest(tx, ctx.tenantId, id);
    if (!exit || (await businessKind(tx, ctx.tenantId, id)) !== kind)
      throw new AppError('NOT_FOUND', kind === 'retirement' ? '退休单不存在' : '离职单不存在');
  });
}

/** 撤回不接受参数；提交只接受在途调动确认令牌（§8）。 */
export async function transitionBody(c: Context<TenantEnv>, action: 'submit' | 'withdraw') {
  if (!c.req.header('content-type')) return undefined;
  const body = await jsonBody(c);
  if (action === 'withdraw') return void parse(z.strictObject({}), body);
  return parse(z.strictObject({ pendingTransferAck: z.string().max(200).optional() }), body).pendingTransferAck;
}

function registerExitChanges(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  // 编辑离职（B14）：非日期字段；日期与当前值不同 → 400 EXIT_DATE_IMMUTABLE（§7.2），审批中的单另需审批管理员按钮
  router.patch('/exits/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const patch = parseExitPatch(await jsonBody(c));
    const current = await authorizeBusinessWrite(deps, ctx, id);
    await requireExitBusiness(deps, ctx, id);
    const gate = { employeeId: current.employeeId, patch: patch.dates, payload: patch.fields };
    return runWrite(
      c,
      deps,
      ctx,
      patch,
      async (tx, context) => ({ status: 200, body: await updateExitFields(tx, context, id, patch) }),
      { guard: exitEditGuard(deps, ctx, gate, id) },
    );
  });
  // 提交（含撤回 / 驳回后重提，只允许原发起人）与撤回：只要 DimissionApproval（hr 发起），不要求 Employment.Submit / Withdraw
  for (const action of ['submit', 'withdraw'] as const)
    router.post(`/exits/:id/${action}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      const ack = await transitionBody(c, action);
      const current = await authorizeBusinessWrite(deps, ctx, id);
      await requireExitBusiness(deps, ctx, id);
      return runWrite(
        c,
        deps,
        ctx,
        { id, action, ...(ack ? { ack } : {}) },
        async (tx, context) => {
          if (action === 'submit') return { status: 200, body: await submitExit(tx, context, id, ack) };
          const business = await transitionEmployment(tx, context, { id, action });
          await employmentApprovalHooks.withdrawn(tx, context, id);
          return { status: 200, body: business };
        },
        { guard: exitCommandGuard(deps, ctx, action, { employeeId: current.employeeId }, { businessId: id }) },
      );
    });
}

// ---- 撤销离职（B4，设计 §7.1 / §7.3 / §9.1）------------------------------------------------------------------------

const cancelSchema = z.strictObject({ reason: z.string().max(500), confirmed: z.boolean().optional() });

/**
 * 撤销回执响应前的按查看人裁剪：业务头按任职字段权，撤销清单目标按各自对象的可见性（不可见只计 hiddenCount）。
 * 命令台账里存的是未裁剪的清单，重放同样走这里，所以撤权后重放得到的也是按当前权限裁剪的结果。
 */
async function projectCancelReceipt(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown) {
  const { cancellation, downstream, ...business } = body as {
    cancellation: unknown;
    downstream: Downstream;
    employeeId: string;
  };
  const trimmed = (await trimEmploymentResponse(deps, ctx, business)) as Record<string, unknown>;
  const visible = await withTenant(deps.db, ctx.tenantId, (tx) =>
    trimDownstream(tx, ctx, downstream, business.employeeId),
  );
  return { ...trimmed, cancellation, downstream: visible };
}

/**
 * POST exits/:id/cancel、POST retirements/:id/cancel 与通用 DELETE businesses/:id（对离职 / 退休单映射到撤销）共用：
 * 解析 { reason, confirmed? }，命令内复核权限（按钮取 buttonsOf(kind).cancel）与范围，同一事务执行 cancelExit。
 * reason 缺失 / 空白 400；超编走 DEC-258 确认（confirmed: true 重提）。
 */
export async function runExitCancel(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  employeeId: string,
  deleting = false,
  kind: 'leave' | 'retirement' = 'leave',
) {
  // 权限链先于校验（§9.1）：无 DimissionCancel / RetireCancel 者先得 403，不因缺原因而得 400
  await requireExitPermission(ctx, 'cancel', { employeeId, deleting, kind });
  const parsed = cancelSchema.safeParse(await jsonBody(c).catch(() => ({})));
  if (!parsed.success || !parsed.data.reason.trim())
    throw new AppError('VALIDATION_FAILED', `请填写撤销${exitKindLabel(kind)}原因`, {
      reason: 'EXIT_CANCEL_REASON_REQUIRED',
      issues: parsed.success ? [] : parsed.error.issues,
    });
  const input = parsed.data;
  return runWrite(
    c,
    deps,
    ctx,
    { id, ...input },
    async (tx, context) => ({ status: 200, body: await cancelExit(tx, context, id, input) }),
    {
      guard: exitCommandGuard(deps, ctx, 'cancel', { employeeId, deleting, kind }, { businessId: id }),
      project: (body) => projectCancelReceipt(deps, ctx, body),
    },
  );
}

/**
 * 撤销记录的入口校验（PATCH exits|retirements/cancellations/:id 共用）：记录不存在、所属业务不是该路径的业务类型、
 * 所属员工在范围外是同一个 404、同一文案，不泄露撤销记录是否存在（退休 R2-T04 §6：路径的业务类型与单据 kind 一致）。
 */
export async function requireCancellationOwner(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  kind: 'leave' | 'retirement',
) {
  const missing = () => new AppError('NOT_FOUND', '撤销的离职记录不存在');
  const owner = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const found = await cancellationOwner(tx, ctx.tenantId, id);
    if (!found || (await businessKind(tx, ctx.tenantId, found.businessId)) !== kind) return undefined;
    await requireEmployeeInScope(tx, ctx, found.employeeId).catch(() => Promise.reject(missing()));
    return found;
  });
  if (!owner) throw missing();
  return owner;
}

function registerExitCancel(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  // 撤销：功能权 object.update → DimissionCancel → 范围（范围外 404）→ 原因 / 确认 → 命令内 §6B（approved / effective）
  router.post('/exits/:id/cancel', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await requireEmploymentWrite(ctx, 'update', {}, EXIT_BUTTONS.cancel, undefined, { commandOnly: true });
    const current = await authorizeBusinessWrite(deps, ctx, id);
    await requireExitBusiness(deps, ctx, id);
    return runExitCancel(c, deps, ctx, id, current.employeeId);
  });
  // restore：授权先于不支持（B-57）；已撤销 / 作废的离职不能恢复，需要时另发新离职单
  router.post('/exits/:id/restore', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await requireEmploymentWrite(ctx, 'update', {}, EXIT_BUTTONS.cancel, undefined, { commandOnly: true });
    await authorizeBusinessWrite(deps, ctx, id);
    await requireExitBusiness(deps, ctx, id);
    return rejectRestore();
  });
  // 修改撤销原因（DM-R5）：只有 reason 可改；If-Match = 撤销记录 revision；范围按所属员工
  router.patch('/exits/cancellations/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await requireEmploymentWrite(ctx, 'update', {}, EXIT_BUTTONS.cancel, undefined, { commandOnly: true });
    const owner = await requireCancellationOwner(deps, ctx, id, 'leave');
    const { reason } = parse(z.strictObject({ reason: z.string().max(500) }), await jsonBody(c));
    return runWrite(
      c,
      deps,
      ctx,
      { id, reason },
      async (tx, context) => ({ status: 200, body: await updateCancellationReason(tx, context, id, reason) }),
      { guard: exitCommandGuard(deps, ctx, 'cancel', { employeeId: owner.employeeId }, {}), project: (body) => body },
    );
  });
}

// ---- 视图与详情（B5，设计 §3.2 / §9.1）-------------------------------------------------------------------------

const code = z.string().trim().min(1).max(100);
const viewQuery = z.object({
  view: z.enum(EXIT_VIEWS),
  departmentId: normalizedUuid.optional(),
  includeChildren: enabledQuery,
  keyword: z.string().trim().min(1).max(100).optional(),
  lastWorkDateFrom: day.optional(),
  lastWorkDateTo: day.optional(),
  exitTypeCode: code.optional(),
  reasonCode: code.optional(),
  whereaboutsCode: code.optional(),
  status: z.enum(EXIT_STATES).optional(),
  initiation: z.enum(EXIT_INITIATIONS).optional(),
});
const VIEW_QUERY_KEYS = Object.keys(viewQuery.shape);

/** 审批状态筛选只用于离职中 / 全部视图；日期区间首尾颠倒按非法处理。 */
function parseViewQuery(c: Context<TenantEnv>) {
  const raw = Object.fromEntries(VIEW_QUERY_KEYS.map((key) => [key, c.req.query(key)]));
  const query = parse(viewQuery, raw);
  if (query.status && !['in_progress', 'all'].includes(query.view))
    throw new AppError('VALIDATION_FAILED', '审批状态只用于离职中和全部离职记录视图');
  if (query.lastWorkDateFrom && query.lastWorkDateTo && query.lastWorkDateFrom > query.lastWorkDateTo)
    throw new AppError('VALIDATION_FAILED', '最后工作日区间的起止日期颠倒');
  return query;
}

/** 姓名 / 工号属人员对象，其余按任职记录对象；无字段权限配置 = 全可见（同实习视图）。 */
async function viewableIn(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<ExitViewable> {
  const [employee, employment] = await Promise.all([
    getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT),
    getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT),
  ]);
  const has = (set: ReadonlySet<string> | undefined) => (field: string) => set === undefined || set.has(field);
  return { employee: has(employee), employment: has(employment) };
}

/** 筛选用到的字段必须可见，否则 403，不让筛选成为看不见字段的探针（同实习视图）。 */
function requireViewableExitFilters(filter: ExitViewFilter, show: ExitViewable) {
  const fields = filterFieldsOf(filter);
  if (!fields.employee.every(show.employee) || !fields.employment.every(show.employment))
    throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

function registerExitViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 四个视图：分页前按可见范围过滤，total 不含范围外的单；字段按查看人裁剪
  router.get('/exits', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const { view, departmentId, includeChildren, ...rest } = parseViewQuery(c);
    const page = pageQuery(c);
    const filter: ExitViewFilter = { ...rest, ...(departmentId ? { departmentIds: [departmentId] } : {}) };
    const show = await viewableIn(deps, ctx);
    requireViewableExitFilters(filter, show);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const { items, total } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const departmentIds = departmentId
        ? await resolveDepartmentIds(tx, ctx.tenantId, departmentId, includeChildren !== 'false', today)
        : undefined;
      return listExitView(tx, ctx.tenantId, { view, page, filter: { ...filter, departmentIds }, show }, ctx.scope);
    });
    return c.json({
      items: items.map((item) => trimExit(item, show)),
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  // 详情：范围外 / 不存在 / 不是离职单同一个 404；先按任职业务口径（DEC-177）确认可见，再取离职详情
  router.get('/exits/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const detail = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      (await loadEmploymentBusiness(tx, ctx.tenantId, id, today, ctx.scope))
        ? loadExitDetail(tx, ctx.tenantId, id, ctx.scope)
        : null,
    );
    if (!detail) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: detail.employeeId });
    return c.json(trimExitDetail(detail, await viewableIn(deps, ctx)));
  });
}
