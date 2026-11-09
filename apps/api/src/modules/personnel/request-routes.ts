import { withTenant } from '@italent/db';
import { buttonResource, PERSONNEL_REQUEST_OBJECT, SUBSETS, type SubsetKind } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { revision, uuidParam } from '../job/context.js';
import { access, preflight, trim } from './access.js';
import { assertSelfServiceFields, createChange, loadChange, requireSelf } from './change-requests.js';
import { LIVE_VIEW, openContentRead } from '../approval/frozen-read.js';
import { AppError } from '../../errors.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { loadPersonnelContent, projectPersonnelRequest, type PersonnelContent } from './frozen.js';
import { personnelApprovalHooks } from './approval-hooks.js';
import { body, safe } from './http.js';
import { parse, subsetInput, subsetKind } from './validation.js';
import { tenantOf } from '../../tenant-context.js';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';

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
        await assertSelfServiceFields(tx, tenant.tenantId, kind, Object.keys(input.values));
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
  // F-476 P5：已办人读办理时冻结的申请内容与原值，审批参与人读现值（均按节点表单 ∩ 字段权限披露，不套本人 / 人员范围）；
  // 本人读现值保持原样。无关人员与不存在同为 404（DEC-834④）。
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'view');
      const id = uuidParam(c);
      const read = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const row = await loadChange(tx, ctx, id);
        const subset = String(row.subset) as SubsetKind;
        const objectCode = SUBSETS[subset].objectCode;
        const content = await openContentRead<PersonnelContent>(tx, deps, ctx, 'personnel_change', id, objectCode);
        if (content?.frozen) return { content: content.frozen.ext, nested: content.fields, view: content.contentView };
        const bound = authorizeInTransaction(deps.authorize, tx);
        const self = await requireSelf(tx, ctx, String(row.employeeId)).then(
          () => true,
          (error: unknown) => {
            if (content && error instanceof AppError && error.code === 'NOT_FOUND') return false;
            throw error;
          },
        );
        const live = await loadPersonnelContent(tx, ctx.tenantId, id);
        if (!self) return { content: live, nested: content!.fields, view: content!.contentView, approver: true };
        const nested = await getModuleViewableFieldsInTransaction({ ...deps, authorize: bound }, ctx, objectCode, tx);
        return { content: live, nested, view: content?.contentView ?? LIVE_VIEW, self: true };
      });
      if (read.self) await preflight(deps, ctx, String(read.content.request.employeeId));
      const body = projectPersonnelRequest(read.content, read.nested, !read.self);
      // 审批节点披露见审批中心（R1-T07）；申请元数据接口不暴露未裁剪的变更内容。
      return c.json({ ...(await trim(deps, ctx, PERSONNEL_REQUEST_OBJECT, body)), contentView: read.view });
    }),
  );
}
