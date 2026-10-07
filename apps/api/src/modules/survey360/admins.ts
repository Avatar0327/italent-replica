/**
 * 360 独立管理员身份（DEC-027）与租户评价角色（DEC-033）。
 * 任命 / 撤销 360 管理员：360 系统管理员，或企业设置里持“管理员”管理能力的企业管理员（租户首位 360 系统管理员
 * 由其指定）。TODO(需取证 #104)：原站首位 360 系统管理员的来源未取证，暂定如此，集中在 adminManager。
 */
import { and, eq, sql, survey360Admins, survey360Roles, type Tx, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { assertActiveMember } from '../permission/members.js';
import { uuidParam } from '../job/context.js';
import {
  actor,
  type Admin,
  audit360,
  fail,
  loadAdmin,
  read,
  requireNewObject,
  requireRevision,
  rows,
  SYSTEM_ONLY,
  text,
  optionalText,
  uuid,
  write,
} from './context.js';

/** 管理员管理的操作者：360 系统管理员，或企业管理员（管理员管理能力）。 */
function adminManager(deps: TenantRouteDeps) {
  return async (tx: Tx, tenant: TenantContext): Promise<Admin> => {
    const admin = await loadAdmin(tx, tenant.userId);
    if (admin?.role === 'system') return admin;
    const allowed = await authorizeInTransaction(deps.authorize, tx)({ ...tenant, action: 'admin.admin_manage' });
    if (!allowed) fail('FORBIDDEN', '无权管理 360 管理员');
    return { id: '', userId: tenant.userId, role: 'system' };
  };
}

function adminView(row: typeof survey360Admins.$inferSelect) {
  return { id: row.id, userId: row.userId, role: row.role, status: row.status, revision: row.revision };
}

/** 内置角色（E3-R4）按需补齐；租户首次使用 360 时写入。 */
export async function ensureBuiltinRoles(tx: Tx, tenantId: string): Promise<void> {
  for (const [index, role] of survey360.BUILTIN_ROLES.entries()) {
    await tx
      .insert(survey360Roles)
      .values({ tenantId, code: role.code, name: role.name, sort: index })
      .onConflictDoNothing();
  }
}

export async function roleIdOf(tx: Tx, code: survey360.BuiltinRoleCode): Promise<string> {
  const [row] = await tx.select({ id: survey360Roles.id }).from(survey360Roles).where(eq(survey360Roles.code, code));
  if (!row) fail('CONFLICT', '内置评价角色缺失', 'BUILTIN_ROLE_MISSING');
  return row.id;
}

function roleView(row: typeof survey360Roles.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    displayText: row.displayText,
    builtin: row.code !== null,
    sort: row.sort,
    revision: row.revision,
  };
}

export function registerAdminRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const manager = adminManager(deps);

  module.get('/me', async (c) => {
    const tenant = tenantOf(c);
    const admin = await withTenant(deps.db, tenant.tenantId, (tx) => loadAdmin(tx, tenant.userId));
    return c.json({ role: admin?.role ?? null });
  });

  module.get('/admins', async (c) => {
    const tenant = tenantOf(c);
    const items = await withTenant(deps.db, tenant.tenantId, async (tx) => {
      await manager(tx, tenant);
      return (await tx.select().from(survey360Admins).where(eq(survey360Admins.status, 'active'))).map(adminView);
    });
    return c.json({ items });
  });

  module.post('/admins', (c) =>
    write(
      c,
      deps,
      z.strictObject({ userId: uuid, role: z.enum(['system', 'advanced', 'general']) }),
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        await assertActiveMember(tx, input.userId);
        if (await loadAdmin(tx, input.userId)) fail('CONFLICT', '该用户已持有 360 管理员身份', 'ALREADY_ADMIN');
        await ensureBuiltinRoles(tx, ctx.tenantId);
        const [row] = await tx
          .insert(survey360Admins)
          .values({ tenantId: ctx.tenantId, userId: input.userId, role: input.role, createdBy: ctx.userId })
          .returning();
        const view = adminView(row!);
        await audit360(tx, actor(ctx), {
          action: 'survey360.admin.create',
          objectType: 'survey360-admin',
          objectId: view.id,
          before: null,
          after: view,
        });
        return view;
      },
      { actor: manager, status: 201 },
    ),
  );

  module.delete('/admins/:id', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        const [row] = await tx
          .select()
          .from(survey360Admins)
          .where(and(eq(survey360Admins.id, id), eq(survey360Admins.status, 'active')))
          .for('update');
        if (!row) fail('NOT_FOUND', '管理员不存在');
        requireRevision(row.revision, ctx.expectedRevision);
        const [saved] = await tx
          .update(survey360Admins)
          .set({ status: 'revoked', revision: row.revision + 1 })
          .where(eq(survey360Admins.id, id))
          .returning();
        // 撤销身份不连带删除活动授权（硬规则：身份与范围分开存放）
        await audit360(tx, actor(ctx), {
          action: 'survey360.admin.revoke',
          objectType: 'survey360-admin',
          objectId: id,
          before: adminView(row),
          after: adminView(saved!),
        });
        return adminView(saved!);
      },
      { actor: manager },
    );
  });

  registerRoleRoutes(module, deps);
}

function registerRoleRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/roles', (c) =>
    read(c, deps, async (tx) => ({
      items: (await tx.select().from(survey360Roles).orderBy(survey360Roles.sort, survey360Roles.createdAt)).map(
        roleView,
      ),
    })),
  );
  const body = z.strictObject({ name: text(50), displayText: optionalText(50) });
  module.post('/roles', (c) =>
    write(
      c,
      deps,
      body,
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        await ensureBuiltinRoles(tx, ctx.tenantId);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:survey360-roles`}, 0))`);
        const [count] = rows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM survey360_roles`));
        if (count!.n >= survey360.SURVEY360_LIMITS.tenantRoles)
          fail('VALIDATION_FAILED', '评价角色最多 90 个', 'TOO_MANY_ROLES');
        const [row] = await tx
          .insert(survey360Roles)
          .values({ tenantId: ctx.tenantId, name: input.name, displayText: input.displayText ?? null, sort: count!.n })
          .returning();
        const view = roleView(row!);
        await audit360(tx, actor(ctx), {
          action: 'survey360.role.create',
          objectType: 'survey360-role',
          objectId: view.id,
          before: null,
          after: view,
        });
        return view;
      },
      { roles: SYSTEM_ONLY, status: 201 },
    ),
  );
  module.put('/roles/:id', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      body.partial(),
      async (tx, ctx, input) => {
        const [row] = await tx.select().from(survey360Roles).where(eq(survey360Roles.id, id)).for('update');
        if (!row) fail('NOT_FOUND', '评价角色不存在');
        requireRevision(row.revision, ctx.expectedRevision);
        if (row.code !== null && input.name !== undefined && input.name !== row.name)
          fail('VALIDATION_FAILED', '内置角色不能改名', 'BUILTIN_ROLE');
        const [saved] = await tx
          .update(survey360Roles)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
            revision: row.revision + 1,
          })
          .where(eq(survey360Roles.id, id))
          .returning();
        await audit360(tx, actor(ctx), {
          action: 'survey360.role.update',
          objectType: 'survey360-role',
          objectId: id,
          before: roleView(row),
          after: roleView(saved!),
        });
        return roleView(saved!);
      },
      { roles: SYSTEM_ONLY },
    );
  });
}
