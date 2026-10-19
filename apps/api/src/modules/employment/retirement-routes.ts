/**
 * R2-T04 退休路由（5a：preview / 新建 / 编辑 / 提交 / 撤回；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * 与离职路由（exit-routes.ts）同一权限链与同一申请服务，差异只有按钮（Employment.Retire*，不复用 Dimission*）与退休专有字段；
 * 写入口的按钮、范围、字段在命令事务内按当前授权复核（exitCommandGuard / exitEditGuard，#199）。
 */
import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody, readContext, requireEmploymentScope, revision, runWrite, uuidParam } from './context.js';
import { createExitApplication, parseExitPatch, updateExitFields, type ExitPatch } from './exit-application.js';
import { submitExit } from './exit-batch.js';
import {
  parse,
  day,
  parseExitCreate,
  requireExitBusiness,
  requirePreviewButton,
  transitionBody,
} from './exit-routes.js';
import { previewExit } from './exit-preview.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import type { BusinessWriteGuard } from './entry-routes.js';
import { assertRetirementFields, assertRetirementImmutableKeys } from './retirement-application.js';
import { exitCommandGuard, exitEditGuard } from './replay-guard.js';
import { registerRetirementViews } from './retirement-view-routes.js';
import { transitionEmployment } from './transitions.js';

const KIND = 'retirement' as const;

/** PATCH retirements/:id 与审批编辑共用的解析：返聘键创建后不可改，离职专用字段拒绝，日期键交给门禁比较（c1）。 */
export function parseRetirementPatch(raw: unknown): ExitPatch {
  assertRetirementImmutableKeys(raw);
  const patch = parseExitPatch(raw);
  assertRetirementFields(patch.fields);
  return patch;
}

export function registerRetirementRoutes(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  registerRetirementViews(router, deps);
  registerRetirementCreate(router, deps);
  registerRetirementChanges(router, deps, authorizeBusinessWrite);
}

function registerRetirementCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 预览：员工范围（范围外 404）+ Retire / RetireApproval 任一；只读，清单逐项按可见性披露
  router.post('/retirements/employees/:id/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view', 0, id);
    const { lastWorkDate } = parse(z.strictObject({ lastWorkDate: day }), await jsonBody(c));
    await requirePreviewButton(deps, ctx, KIND);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => previewExit(tx, ctx, id, lastWorkDate, KIND)));
  });
  // 新建（HR 端，退休申请 / 直接退休）：与通用入口同一申请服务与门禁；不要求 Employment.Create
  router.post('/retirements/employees/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const input = parseExitCreate(ctx, await jsonBody(c), KIND);
    const departmentId = input.fields.departmentId;
    if (departmentId !== undefined) requireEmploymentScope(ctx, id, departmentId);
    const gate = {
      employeeId: id,
      kind: KIND,
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
        body: await createExitApplication(tx, context, { ...input, kind: KIND, employeeId: id, initiation: 'hr' }),
      }),
      { guard: exitCommandGuard(deps, ctx, 'create', gate, { departmentId }) },
    );
  });
}

function registerRetirementChanges(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  // 编辑退休：非日期字段；日期与当前值不同 → 400 EXIT_DATE_IMMUTABLE（c1），审批中的单另需审批管理员按钮
  router.patch('/retirements/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const patch = parseRetirementPatch(await jsonBody(c));
    const current = await authorizeBusinessWrite(deps, ctx, id);
    await requireExitBusiness(deps, ctx, id, KIND);
    const gate = { employeeId: current.employeeId, kind: KIND, patch: patch.dates, payload: patch.fields };
    return runWrite(
      c,
      deps,
      ctx,
      patch,
      async (tx, context) => ({ status: 200, body: await updateExitFields(tx, context, id, patch, { kind: KIND }) }),
      { guard: exitEditGuard(deps, ctx, gate, id) },
    );
  });
  // 提交（含撤回 / 驳回后重提，只允许原发起人）与撤回：只要 RetireApproval（hr 发起）
  for (const action of ['submit', 'withdraw'] as const)
    router.post(`/retirements/:id/${action}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      const ack = await transitionBody(c, action);
      const current = await authorizeBusinessWrite(deps, ctx, id);
      await requireExitBusiness(deps, ctx, id, KIND);
      const target = { employeeId: current.employeeId, kind: KIND };
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
        { guard: exitCommandGuard(deps, ctx, action, target, { businessId: id }) },
      );
    });
}
