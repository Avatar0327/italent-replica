/**
 * 360 设置（DEC-280②⑤；DEC-033）：评价角色设置与“精细化权限”开关。360 内没有管理员设置页——360 身份由企业管理员
 * 在权限管理“用户授权”里授予（身份 × 应用 Survey360），见 context.ts。
 */
import { eq, sql, survey360Roles, survey360Settings, type Tx } from '@italent/db';
import { survey360 } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import {
  actor,
  audit360,
  BUTTONS,
  fail,
  optionalText,
  read,
  requireNewObject,
  requireRevision,
  rows,
  text,
  write,
} from './context.js';

/** 内置角色（E3-R4）按需补齐：租户首次使用 360 时写入（读角色与每个写命令前）。 */
export async function ensureBuiltinRoles(tx: Tx, tenantId: string): Promise<void> {
  await tx
    .insert(survey360Roles)
    .values(survey360.BUILTIN_ROLES.map((role, index) => ({ tenantId, code: role.code, name: role.name, sort: index })))
    .onConflictDoNothing();
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

async function loadSettings(tx: Tx) {
  const [row] = await tx.select().from(survey360Settings).limit(1);
  return { finePermission: row?.finePermission ?? false, revision: row?.revision ?? 0 };
}

const VIEW = { object: 'settings' } as const;

/** 评价角色新增的租户级串行化（角色数量上限检查）。 */
export async function lockRoleSettings(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:survey360-roles`}, 0))`);
}

export function registerSettingsRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 设置 / 评价角色入口只读写设置与角色，不用活动 / 人员可见范围：不预取 Activity 查看权与“全部活动”按钮（F-075，DEC-369）
  module.get('/settings', (c) => read(c, deps, VIEW, (tx) => loadSettings(tx), undefined, 'identity'));
  module.put('/settings', (c) =>
    write(
      c,
      deps,
      z.strictObject({ finePermission: z.boolean() }),
      async (tx, ctx, input) => {
        const before = await loadSettings(tx);
        requireRevision(before.revision, ctx.expectedRevision);
        const values = { finePermission: input.finePermission, updatedBy: ctx.userId, updatedAt: ctx.now };
        const [saved] = await tx
          .insert(survey360Settings)
          .values({ tenantId: ctx.tenantId, ...values })
          .onConflictDoUpdate({
            target: survey360Settings.tenantId,
            set: { ...values, revision: sql`${survey360Settings.revision} + 1` },
            setWhere: sql`${survey360Settings.revision} = ${before.revision}`,
          })
          .returning();
        if (!saved) fail('REVISION_CONFLICT', '设置已被修改，请刷新后显式重提');
        const after = { finePermission: saved.finePermission, revision: saved.revision };
        await audit360(tx, actor(ctx), {
          action: 'survey360.settings.update',
          objectType: 'survey360-settings',
          objectId: ctx.tenantId,
          before,
          after,
        });
        return after;
      },
      {
        need: { object: 'settings', operation: 'update', button: BUTTONS.finePermission },
        fields: 'body',
        admin: 'identity',
      },
    ),
  );
  registerRoleRoutes(module, deps);
}

function registerRoleRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 评价角色属“设置”对象：查看要设置的查看权并按其字段裁剪（第 3 轮取消“持有人即可读”的选择器例外）
  module.get('/roles', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, _admin, tenant) => {
        await ensureBuiltinRoles(tx, tenant.tenantId);
        const items = await tx.select().from(survey360Roles).orderBy(survey360Roles.sort, survey360Roles.createdAt);
        return { items: items.map(roleView) };
      },
      undefined,
      'identity',
    ),
  );
  const body = z.strictObject({ name: text(50), displayText: optionalText(50) });
  module.post('/roles', (c) =>
    write(
      c,
      deps,
      body,
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        await lockRoleSettings(tx, ctx.tenantId);
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
      { need: { object: 'settings', operation: 'create' }, fields: 'body', status: 201, admin: 'identity' },
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
      { need: { object: 'settings', operation: 'update' }, fields: 'body', admin: 'identity' },
    );
  });
}
