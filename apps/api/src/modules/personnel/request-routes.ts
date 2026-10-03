import { withTenant } from '@italent/db';
import { buttonResource, PERSONNEL_REQUEST_OBJECT } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { revision, uuidParam } from '../job/context.js';
import { access, preflight, trim } from './access.js';
import { createChange, loadChange, requireSelf } from './change-requests.js';
import { personnelApprovalHooks } from './approval-hooks.js';
import { body, safe } from './http.js';
import { parse, subsetInput, subsetKind } from './validation.js';
import { tenantOf } from '../../tenant-context.js';
import { requirePermission } from '../../authorization.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';

const base = '/api/tenant/personnel/change-requests';
const requestSchema = z
  .object({
    employeeId: z.uuid(),
    subset: z.string(),
    recordId: z.uuid().optional(),
    targetRevision: z.number().int().nonnegative().optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
export function registerChangeRequestRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(base, (c) =>
    safe(async () => {
      const raw = parse(requestSchema, await body(c));
      const kind = subsetKind(raw.subset);
      const input = { ...raw, subset: kind, values: subsetInput(kind, raw.values, true) };
      const tenant = tenantOf(c);
      await requirePermission(deps.authorize, {
        ...tenant,
        action: 'object.button',
        resource: buttonResource(PERSONNEL_REQUEST_OBJECT, 'self-service-submit', 'list'),
      });
      await withTenant(deps.db, tenant.tenantId, async (tx) => {
        await requireSelf(tx, { ...tenant, now: deps.clock(), commandId: '', expectedRevision: 0 }, input.employeeId);
        const setting = await readEffectiveSetting(tx, tenant.tenantId, 'personnel.self_service_fields');
        const configured = (setting.value as Record<string, unknown>)[kind];
        const allowed = new Set(
          Array.isArray(configured) ? configured.filter((v): v is string => typeof v === 'string') : [],
        );
        if (Object.keys(input.values).some((field) => !allowed.has(field)))
          throw new AppError('FORBIDDEN', '字段不在员工自助修改清单内');
      });
      const expectedRevision = revision(c);
      const ctx = { ...tenant, now: deps.clock(), commandId: '', expectedRevision };
      const result = await runCommand(deps.db, ctx, {
        id: c.req.header('idempotency-key'),
        fingerprint: { operation: 'personnel.self-service-request', input, expectedRevision },
        execute: async (tx, commandId) => {
          const created = await createChange(tx, { ...ctx, commandId }, input);
          // R1-T07：申请与审批实例同事务创建；没有可用流程即整单回滚，不留无人审批的申请。
          await personnelApprovalHooks.submitted(tx, { ...ctx, commandId }, created.id);
          return { status: 201, body: created };
        },
      });
      return c.json(result.body, 201);
    }),
  );
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'view');
      const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const row = await loadChange(tx, ctx, uuidParam(c));
        await requireSelf(tx, ctx, String(row.employeeId));
        return row;
      });
      await preflight(deps, ctx, String(result.employeeId));
      // 审批节点披露见审批中心（R1-T07）；申请元数据接口不暴露未裁剪的变更内容。
      return c.json(await trim(deps, ctx, PERSONNEL_REQUEST_OBJECT, result));
    }),
  );
}
