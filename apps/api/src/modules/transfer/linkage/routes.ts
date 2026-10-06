/** 联动接口：查看联动、修改联动选项、重试失败子项、选择要变更的合同（挂在 /api/tenant/employment/transfers 下）。 */
import { sql, withTenant, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import { tenantOf, type TenantEnv } from '../../../tenant-context.js';
import { checkScope } from '../../contracts/context.js';
import {
  EMPLOYMENT_OBJECT,
  jsonBody,
  readContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
} from '../../employment/context.js';
import { loadEmploymentBusiness } from '../../employment/read-model.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import { authorizeInTransaction, getModuleViewableFields, resolveModuleScope } from '../../permission/module-access.js';
import {
  authorizeLinkageWrite,
  authorizeOrgRole,
  authorizeSubordinateField,
  resolveLinkageAccess,
  type LinkageAccess,
} from './access.js';
import { normalizeLinkage, type DutyRelation, type LinkageOptions, type OrgRole } from './input.js';
import { loadLinkageItem, retryLinkageItem } from './items.js';
import { requireLinkageSource, updateTransferLinkage } from './service.js';
import { linkageBeforeCommand } from './store.js';
import { registerTransferDeletionProbes } from './deletion-probes.js';
import { readTransferLinkage } from './view.js';

type Deps = TenantRouteDeps;

/**
 * 命令外按当前权限先授权一次：幂等重放不进入命令体，同样经过这里（PR #74 第二轮 P1-2）。
 * 修改联动按新旧差异授权（第三轮 P1-2）；重放时“旧”取该命令写入之前的版本，与首次请求同一口径。
 */
export async function preauthorizeLinkage(
  c: Context<TenantEnv>,
  deps: Deps,
  ctx: EmploymentContext,
  input: { employeeId: string; operation: 'create' | 'update'; options: LinkageOptions | null; businessId?: string },
): Promise<LinkageAccess | undefined> {
  const { businessId, ...write } = input;
  if (!write.options) return undefined;
  const before = businessId
    ? await withTenant(deps.db, ctx.tenantId, (tx) =>
        linkageBeforeCommand(tx, ctx.tenantId, businessId, c.req.header('idempotency-key')),
      )
    : null;
  const access = await resolveLinkageAccess(deps, tenantOf(c), write.options, before);
  await withTenant(deps.db, ctx.tenantId, (tx) =>
    authorizeLinkageWrite(tx, { ...ctx, authorize: authorizeInTransaction(deps.authorize, tx) }, access, {
      ...write,
      options: write.options!,
      before,
    }),
  );
  return access;
}

export function registerTransferLinkageRoutes(router: Hono<TenantEnv>, deps: Deps) {
  registerTransferDeletionProbes();
  router.get('/transfers/:id/linkage', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view');
    const tenant = tenantOf(c);
    const visibility = {
      employmentFields: await getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT),
      contract: {
        visible: await deps.authorize({ ...tenant, action: 'object.view', resource: CONTRACT_OBJECT }),
        scope: await resolveModuleScope(deps, tenant, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`),
        fields: await getModuleViewableFields(deps, ctx, CONTRACT_OBJECT),
      },
    };
    const view = await withTenant(deps.db, ctx.tenantId, (tx) => readTransferLinkage(tx, ctx, id, visibility));
    return c.json(view);
  });
  router.put('/transfers/:id/linkage', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const raw = await jsonBody(c);
    const options = normalizeLinkage(raw);
    const business = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone), ctx.scope),
    );
    if (!business || business.kind !== 'transfer') throw new AppError('NOT_FOUND', '调动不存在');
    // DEC-194：本人护栏与调动入口同一判定（F-017）；命令外先判，幂等重放同样经过。
    await withTenant(deps.db, ctx.tenantId, (tx) => requireLinkageSource(tx, ctx, id, business.employeeId));
    const input = { employeeId: business.employeeId, operation: 'update' as const, options, businessId: id };
    const access = await preauthorizeLinkage(c, deps, ctx, input);
    return runWrite(c, deps, ctx, raw, async (tx, context) => ({
      status: 200,
      body: await updateTransferLinkage(tx, context, id, options, access),
    }));
  });
  registerRetry(router, deps);
  registerContractChoices(router, deps);
}

function registerRetry(router: Hono<TenantEnv>, deps: Deps) {
  router.post('/transfers/linkage-items/:id/retry', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    if (c.req.header('content-type')) parse(z.strictObject({}), await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, 'Employment.RetryActivation');
    const access: LinkageAccess = {};
    // 子项所属调动须对当前操作人可见，改写的字段 / 组织按当前权限判定（每次请求重验，幂等重放同样经此）。
    await withTenant(deps.db, ctx.tenantId, (tx) => authorizeRetry(tx, deps, ctx, id, access));
    return runWrite(c, deps, ctx, { id, action: 'retry-linkage-item' }, async (tx, context) => ({
      status: 200,
      body: await retryLinkageItem(tx, context, id, access),
    }));
  });
}

async function authorizeRetry(tx: Tx, deps: Deps, ctx: EmploymentContext, id: string, access: LinkageAccess) {
  const item = await loadLinkageItem(tx, ctx.tenantId, id);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if (!(await loadEmploymentBusiness(tx, ctx.tenantId, item.businessId, today, ctx.scope)))
    throw new AppError('NOT_FOUND', '联动子项不存在');
  const bound = { ...ctx, authorize: authorizeInTransaction(deps.authorize, tx) };
  if (item.itemType === 'duty_subordinate') await authorizeSubordinateField(bound, item.relation as DutyRelation);
  if (item.itemType === 'duty_org_role')
    await authorizeOrgRole(tx, bound, access, item.orgId!, item.orgRole as OrgRole);
}

/** 表单“变更的合同”候选：该员工当前有效的合同，按合同查看权与合同范围（含创建人）过滤。 */
function registerContractChoices(router: Hono<TenantEnv>, deps: Deps) {
  router.get('/transfers/employees/:id/contracts', async (c) => {
    const employeeId = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view');
    const tenant = tenantOf(c);
    await requirePermission(deps.authorize, { ...tenant, action: 'object.view', resource: CONTRACT_OBJECT });
    const scope = await resolveModuleScope(deps, tenant, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`);
    // 第三轮 P2-2：显示值同样服从合同字段查看权，看不到合同编号时返回 null，由前端按序号显示（DEC-045 文案在前端）。
    const fields = await getModuleViewableFields(deps, ctx, CONTRACT_OBJECT);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = rowsOf<{ id: string; number: string; createdBy: string | null }>(
        await tx.execute(sql`SELECT id, number, created_by AS "createdBy" FROM contract_records
          WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND NOT deleted
            AND status='valid' AND approval_status='effective' ORDER BY effective_date DESC, id LIMIT 50`),
      );
      const visible = [];
      for (const row of rows) {
        try {
          await checkScope(tx, { ...ctx, scope }, employeeId, row.createdBy ?? undefined);
          visible.push({ id: row.id, name: !fields || fields.has('number') ? row.number : null });
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
        }
      }
      return visible;
    });
    return c.json({ items });
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  return parsed.data;
}
