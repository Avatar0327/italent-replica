import { readManagerReferences } from './manager-references.js';
import { businessDate } from '../employment/fields.js';
import { requireTransferSource } from './access.js';
import { resolveTransferForm } from './configuration.js';
import { trimEmploymentManagerReferences } from './response-disclosure.js';
import { sql, withTenant } from '@italent/db';
import { tenantLocalDate, buttonResource } from '@italent/domain';
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { readPageContext, pageQuery, EMPLOYMENT_OBJECT, EMPLOYEE_OBJECT } from '../employment/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { managerIdentity } from '../permission/manager-identity.js';
import { scopeRows } from '../permission/scope-hierarchy.js';
import { listTodos, listInstances } from '../approval/queries.js';
import { readManagerTeam, managerRowLabels } from './manager-team.js';
import { requireTransferButton } from './access.js';

export function registerManagerRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/manager', async (c) => {
    const ctx = await managerContext(c, deps);
    const canApply = await deps.authorize({
      ...ctx,
      action: 'object.button',
      resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Manager', 'detail'),
    });
    return c.json({ identity: 'department_manager', canApply, canViewReporting: await managerHasHr(ctx, deps) });
  });
  for (const kind of ['employees', 'team', 'search'] as const)
    router.get(`/transfers/manager/${kind}`, async (c) => {
      const ctx = await managerContext(c, deps);
      if (kind === 'employees') await requireTransferButton(ctx, 'manager');
      const page = pageQuery(c);
      const category = z
        .enum(['active', 'probation', 'intern', 'pending', 'leaving'])
        .optional()
        .safeParse(c.req.query('category'));
      if (!category.success) throw new AppError('VALIDATION_FAILED', '团队分类不合法');
      const fields = await getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT);
      const personFields = await getModuleViewableFields(deps, ctx, 'TenantBase.EmployeeInformation');
      const employeeFields = await getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT);
      const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
        readManagerTeam(tx, ctx, page, {
          search: c.req.query('search')?.slice(0, 200),
          category: category.data,
          nameSearch: employeeFields === undefined || employeeFields.has('name'),
          codeSearch: employeeFields === undefined || employeeFields.has('code'),
          candidates: kind === 'employees',
          emailSearch: personFields === undefined || personFields.has('email'),
        }),
      );
      const items = result.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(([key]) => {
            if (key === 'avatar') return employeeFields === undefined || employeeFields.has('name');
            if (kind === 'employees' && !['id', 'name', 'code', 'revision'].includes(key)) return false;
            const permissions = ['name', 'code', 'id', 'revision'].includes(key)
              ? employeeFields
              : ['email', 'mobilePhone'].includes(key)
                ? personFields
                : fields;
            // 离职中、试用中是工作台标记列，与计数同一谓词（Q-M0-76 / F-022）
            return (
              ['category', 'leaving', 'probation'].includes(key) || permissions === undefined || permissions.has(key)
            );
          }),
        ),
      );
      const safe = (await trimEmploymentManagerReferences(deps, ctx, items)) as Record<string, unknown>[];
      const displayItems =
        kind === 'employees' ? safe : await withTenant(deps.db, ctx.tenantId, (tx) => managerRowLabels(tx, ctx, safe));
      return c.json({ ...result, items: displayItems, page: page.page, pageSize: page.pageSize });
    });
  registerManagerReferences(router, deps);
  registerManagerTodos(router, deps);
  router.get('/transfers/manager/reporting', async (c) => {
    const ctx = await managerContext(c, deps);
    if (!(await managerHasHr(ctx, deps))) throw new AppError('FORBIDDEN', '需要人事身份');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readManagerTeam(tx, ctx, page, {}));
    const fields = await getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT);
    return c.json({
      items: result.items.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => ['id', 'directManagerId', 'dottedManagerId'].includes(key) && (!fields || fields.has(key)),
          ),
        ),
      ),
    });
  });
}

async function managerContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await readPageContext(c, deps, 'detail');
  const identity = await withTenant(deps.db, ctx.tenantId, (tx) =>
    managerIdentity(tx, { ...ctx, asOf: tenantLocalDate(ctx.now, ctx.timezone) }),
  );
  if (!identity.active) throw new AppError('FORBIDDEN', '需要经理自助身份');
  return ctx;
}

async function managerHasHr(ctx: Awaited<ReturnType<typeof managerContext>>, deps: TenantRouteDeps) {
  return !!(await deps.authorize({
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Hr', 'detail'),
  }));
}

function registerManagerTodos(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/manager/todos', async (c) => {
    const ctx = await managerContext(c, deps);
    const page = pageQuery(c);
    const tab = z.enum(['pending', 'processed', 'initiated']).safeParse(c.req.query('tab') ?? 'pending');
    if (!tab.success) throw new AppError('VALIDATION_FAILED', '待办分类不合法');
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (tab.data === 'pending') return listTodos(tx, ctx.tenantId, ctx.userId, page);
      if (tab.data === 'initiated') return listInstances(tx, ctx.tenantId, ctx.userId, { role: 'initiated' }, page);
      // 已处理不等于参与过：排除待办、抄送、自审跳过与管理员操作。
      return scopeRows(
        await tx.execute(sql`
        SELECT DISTINCT i.id,i.title,i.status,i.created_at AS "createdAt" FROM approval_instances i
        JOIN approval_instance_logs l ON l.tenant_id=i.tenant_id AND l.instance_id=i.id
        WHERE i.tenant_id=${ctx.tenantId} AND l.actor_user_id=${ctx.userId}::uuid
          AND l.event IN ('approve','reject','disagree','transfer')
        ORDER BY i.created_at DESC,i.id LIMIT ${page.limit} OFFSET ${page.offset}
      `),
      );
    });
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
}

function registerManagerReferences(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/manager/references/:field', async (c) => {
    const ctx = await managerContext(c, deps);
    const field = c.req.param('field');
    const fields = await getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT);
    if (fields && !fields.has(field)) throw new AppError('FORBIDDEN', '无权查看调动参照');
    const parsed = z
      .object({
        employeeId: z.uuid().transform((v) => v.toLowerCase()),
        departmentId: z
          .uuid()
          .transform((v) => v.toLowerCase())
          .optional(),
        postId: z
          .uuid()
          .transform((v) => v.toLowerCase())
          .optional(),
        formId: z.string().min(1),
      })
      .safeParse(c.req.query());
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动参照参数不合法');
    const effectiveDate = businessDate(c.req.query('effectiveDate') ?? tenantLocalDate(ctx.now, ctx.timezone));
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await requireTransferSource(tx, ctx, parsed.data.employeeId, 'manager');
      const form = await resolveTransferForm(tx, ctx.tenantId, parsed.data.formId);
      if (!['editable', 'readonly'].includes(form.fieldModes[`preset:${field}`] ?? 'absent'))
        throw new AppError('FORBIDDEN', '无权查看调动参照');
      return readManagerReferences(
        tx,
        ctx,
        field,
        {
          ...parsed.data,
          effectiveDate,
          name: c.req.query('name')?.slice(0, 200),
        },
        page,
      );
    });
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
}
