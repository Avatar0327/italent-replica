/**
 * R2-T03 离职路由（挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts，设计 §4 / §9.2）。
 * 三个字典（B1a）：读取对持任职记录查看权者开放（表单下拉、列表显示名称），写入是配置对象
 * （tenant.employment.configuration.write，管理员 other_settings；字段按任职设置配置对象校验）。
 * 办理入口（B2b）：预览 / 新建 / 批量 / 编辑离职 / 提交 / 撤回。权限链按 §9.1 固定顺序：功能操作权（readContext）→
 * 按钮权 → 范围（范围外 404）→ 字段权 → §4A 前置条件；写入口的按钮、范围、字段在命令事务内按当前授权复核
 * （exitCommandGuard / exitBatchGuard，#199），重放与失败回查同样经过。B3-3 前任何入口都不让离职落地（§18.1）。
 */
import { buttonResource, EXIT_BUTTONS, EXIT_SETTING_KEYS, EXIT_SETTINGS } from '@italent/domain';
import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  EMPLOYMENT_OBJECT,
  jsonBody,
  readContext,
  requireEmploymentScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { createExitApplication, parseExitPatch, updateExitFields } from './exit-application.js';
import { createExitBatch, EXIT_BATCH_LIMIT, submitExit } from './exit-batch.js';
import { loadExitRequest } from './exit-gate.js';
import { exitOptionsSchema, splitExitOptions } from './exit-initiation.js';
import { previewExit } from './exit-preview.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import { businessDate, normalizeEmploymentInput, normalizedUuid } from './fields.js';
import { exitBatchGuard, exitCommandGuard, requireBusinessWriteScope } from './replay-guard.js';
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

export function registerExitRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerExitDictionaries(router, deps);
  registerExitCreate(router, deps);
  registerExitChanges(router, deps);
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
const day = z.string().refine((value) => {
  try {
    return businessDate(value) === value;
  } catch {
    return false;
  }
}, '日期不合法');

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', result.error.issues);
  return result.data;
};

/** 预览：直接离职 / 离职申请两个按钮任一即可（§4A preview 行，功能权是 object.view）；两项都无 → 403。 */
async function requirePreviewButton(deps: TenantRouteDeps, ctx: EmploymentContext) {
  const held = async (code: string) =>
    deps.authorize({ ...ctx, action: 'object.button', resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail') });
  if (!(await held(EXIT_BUTTONS.direct)) && !(await held(EXIT_BUTTONS.application)))
    throw new AppError('FORBIDDEN', '没有离职办理权限');
}

/** 专用新建入口的请求体：任职业务输入（kind 固定为 leave，不接受 kind）+ exit 区块（§4B 字段）。 */
function parseExitCreate(ctx: EmploymentContext, body: unknown) {
  const { rawInput, exit } = splitExitOptions(body);
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput) || 'kind' in rawInput)
    throw new AppError('VALIDATION_FAILED', '离职入口不接受业务类型参数');
  const raw = rawInput as Record<string, unknown>;
  const input = normalizeEmploymentInput(ctx, { fields: {}, ...raw, kind: 'leave' });
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

/** 业务在写入口径范围内且是离职单（有扩展行），否则 404（调动等其他单不能走离职入口）。 */
async function requireExitBusiness(deps: TenantRouteDeps, ctx: EmploymentContext, id: string) {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const business = await requireBusinessWriteScope(tx, deps.authorize, ctx, id);
    if (business.kind !== 'leave' || !(await loadExitRequest(tx, ctx.tenantId, id)))
      throw new AppError('NOT_FOUND', '离职单不存在');
    return business;
  });
}

/** 撤回不接受参数；提交只接受在途调动确认令牌（§8）。 */
async function transitionBody(c: Context<TenantEnv>, action: 'submit' | 'withdraw') {
  if (!c.req.header('content-type')) return undefined;
  const body = await jsonBody(c);
  if (action === 'withdraw') return void parse(z.strictObject({}), body);
  return parse(z.strictObject({ pendingTransferAck: z.string().max(200).optional() }), body).pendingTransferAck;
}

function registerExitChanges(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 编辑离职（B14）：非日期字段；日期与当前值不同 → 400 EXIT_DATE_IMMUTABLE（§7.2），审批中的单另需审批管理员按钮
  router.patch('/exits/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const patch = parseExitPatch(await jsonBody(c));
    const current = await requireExitBusiness(deps, ctx, id);
    const gate = { employeeId: current.employeeId, patch: patch.dates, payload: patch.fields };
    return runWrite(
      c,
      deps,
      ctx,
      patch,
      async (tx, context) => ({ status: 200, body: await updateExitFields(tx, context, id, patch) }),
      { guard: exitCommandGuard(deps, ctx, 'update', gate, { businessId: id }) },
    );
  });
  // 提交（含撤回 / 驳回后重提，只允许原发起人）与撤回：只要 DimissionApproval（hr 发起），不要求 Employment.Submit / Withdraw
  for (const action of ['submit', 'withdraw'] as const)
    router.post(`/exits/:id/${action}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      const ack = await transitionBody(c, action);
      const current = await requireExitBusiness(deps, ctx, id);
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
