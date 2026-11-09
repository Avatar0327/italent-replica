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
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { showOriginalsOf } from '../approval/disclosure.js';
import { loadPersonnelContent, personnelContainers, personnelMetadata, type PersonnelContent } from './frozen.js';
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
  // F-476 P5：只有「本人已办」的审批人读办理时冻结份（按节点表单 ∩ 字段权限披露，不套数据范围，DEC-834④）；
  // 其余人（本人、待办未办、被抄送、任务被取消、无关人员）一律走基线守卫：本人 + 人员范围，否则 404。
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'view');
      const id = uuidParam(c);
      const read = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const row = await loadChange(tx, ctx, id);
        const objectCode = SUBSETS[String(row.subset) as SubsetKind].objectCode;
        const content = await openContentRead<PersonnelContent>(tx, deps, ctx, 'personnel_change', id, objectCode);
        if (content?.frozen) {
          const { ext } = content.frozen;
          return {
            content: ext,
            nested: content.fields,
            view: content.contentView,
            originals: content.data.showOriginals,
          };
        }
        await requireSelf(tx, ctx, String(row.employeeId));
        const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
        return {
          content: await loadPersonnelContent(tx, ctx.tenantId, id),
          nested: await getModuleViewableFieldsInTransaction(bound, ctx, objectCode, tx),
          view: content?.contentView ?? LIVE_VIEW,
          originals: content?.data.showOriginals ?? (await showOriginalsOf(tx, ctx.tenantId)),
          self: true,
        };
      });
      if (read.self) await preflight(deps, ctx, String(read.content.request.employeeId));
      // 审批节点披露见审批中心（R1-T07）；申请元数据按申请对象字段权裁，容器按子集字段权在内部裁。
      const metadata = await trim(deps, ctx, PERSONNEL_REQUEST_OBJECT, personnelMetadata(read.content));
      const containers = personnelContainers(read.content, read.nested, read.originals);
      return c.json({ ...metadata, ...containers, contentView: read.view });
    }),
  );
}
