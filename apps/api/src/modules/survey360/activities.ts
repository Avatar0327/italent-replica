/**
 * 活动（docs/02_业务建模/25 §1 ①④⑤）：草稿 → 启用 → 停用（可再启用）。启用时校验评价对象与套卷、把套卷标为已使用、
 * 给每位评价者发放唯一作答链接（邀请邮件写 outbox）；停用时计分（E3-R15）。
 * 匿名开关（DEC-149）：作答页是否显示评价者姓名、评价角色显示方式，作用于 answering.ts 的作答页。
 */
import { and, eq, sql, survey360ActivityGrants, survey360Activities, survey360People, type Tx } from '@italent/db';
import { survey360 } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { activityView, activityVisibleSql, type ActivityRow, requireActivity, requireObject } from './access.js';
import {
  actor,
  type Admin,
  audit360,
  fail,
  optionalText,
  read,
  requireNewObject,
  requireRevision,
  rows,
  type Survey360Context,
  text,
  uuid,
  write,
} from './context.js';
import { ensureAnswerLink } from './links.js';
import { loadQuestionnaire, markUsed } from './questionnaires.js';
import { computeScores, objectScores } from './scoring.js';

const switches = {
  showAppraiserName: z.boolean(),
  roleDisplay: z.enum(survey360.ROLE_DISPLAY_MODES),
};
const createSchema = z.strictObject({
  name: text(200),
  scene: optionalText(100),
  form: z.enum(['single', 'multiple']),
  welcome: optionalText(5000),
  ...switches,
});
const updateSchema = createSchema.partial();

async function reload(tx: Tx, id: string): Promise<ActivityRow> {
  const [row] = rows<ActivityRow>(await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${id}::uuid`));
  return row!;
}

async function auditActivity(tx: Tx, ctx: Survey360Context, action: string, before: unknown, after: ActivityRow) {
  const view = activityView(after);
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-activity',
    objectId: after.id,
    before,
    after: { ...view, activityId: after.id },
  });
}

async function bump(tx: Tx, current: ActivityRow, values: Partial<typeof survey360Activities.$inferInsert>) {
  const [saved] = await tx
    .update(survey360Activities)
    .set({ ...values, revision: current.revision + 1 })
    .where(and(eq(survey360Activities.id, current.id), eq(survey360Activities.revision, current.revision)))
    .returning({ id: survey360Activities.id });
  if (!saved) fail('REVISION_CONFLICT', '活动已被修改，请刷新后显式重提');
  return reload(tx, current.id);
}

/** 启用前校验（E3-R3）：至少一个评价对象；每个对象 1–3 个可用套卷；评价角色都在对象的套卷里。 */
async function checkEnable(tx: Tx, activityId: string): Promise<string[]> {
  const objects = rows<{ id: string; questionnaire_ids: string[] | null }>(
    await tx.execute(sql`SELECT o.id,
        array_agg(oq.questionnaire_id) FILTER (WHERE oq.id IS NOT NULL) AS questionnaire_ids
      FROM survey360_objects o
      LEFT JOIN survey360_object_questionnaires oq ON oq.tenant_id = o.tenant_id AND oq.object_id = o.id
      WHERE o.activity_id = ${activityId}::uuid AND NOT o.removed GROUP BY o.id`),
  );
  if (objects.length === 0) fail('VALIDATION_FAILED', '活动至少需要一个评价对象', 'NO_OBJECT');
  const used = new Set<string>();
  for (const o of objects) {
    const ids = o.questionnaire_ids ?? [];
    if (ids.length < 1 || ids.length > survey360.SURVEY360_LIMITS.questionnairesPerObject)
      fail('VALIDATION_FAILED', '每个评价对象须有 1～3 个套卷', 'QUESTIONNAIRE_COUNT', { objectId: o.id });
    ids.forEach((id) => used.add(id));
  }
  const rolesOf = new Map<string, Set<string>>();
  for (const id of used) {
    const q = await loadQuestionnaire(tx, id);
    if (q.row.status === 'draft')
      fail('CONFLICT', '套卷尚未启用', 'QUESTIONNAIRE_NOT_ENABLED', { questionnaireId: id });
    const issues = survey360.validateQuestionnaire(q.model);
    if (issues.length)
      fail('VALIDATION_FAILED', '套卷不满足启用条件', 'QUESTIONNAIRE_INVALID', { questionnaireId: id });
    rolesOf.set(id, new Set(q.model.roles.map((r) => r.roleId)));
  }
  const orphan = rows<{ id: string; role_id: string; ids: string[] }>(
    await tx.execute(sql`SELECT r.id, r.role_id, array_agg(oq.questionnaire_id) AS ids FROM survey360_relations r
      JOIN survey360_object_questionnaires oq ON oq.tenant_id = r.tenant_id AND oq.object_id = r.object_id
      WHERE r.activity_id = ${activityId}::uuid AND NOT r.removed GROUP BY r.id, r.role_id`),
  ).find((r) => !r.ids.some((id) => rolesOf.get(id)?.has(r.role_id)));
  if (orphan)
    fail('VALIDATION_FAILED', '评价角色不在评价对象的套卷中', 'ROLE_NOT_IN_QUESTIONNAIRE', { relationId: orphan.id });
  return [...used];
}

/** 给活动里每位评价者发放作答链接（已有的不重复发放）。 */
export async function issueAnswerLinks(tx: Tx, ctx: Survey360Context, activityId: string): Promise<void> {
  const ids = rows<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT r.appraiser_person_id AS id FROM survey360_relations r
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      WHERE r.activity_id = ${activityId}::uuid AND NOT r.removed ORDER BY 1`),
  );
  for (const { id } of ids) {
    const [person] = await tx.select().from(survey360People).where(eq(survey360People.id, id));
    await ensureAnswerLink(tx, ctx, activityId, person!);
  }
}

const guarded = (id: string) => async (tx: Tx, admin: Admin) => void (await requireActivity(tx, admin, id));

function requireManager(admin: Admin, row: ActivityRow): void {
  // 授权只能由系统 / 高级管理员或活动持有人调整
  if (admin.role === 'general' && row.owner_user_id !== admin.userId)
    fail('FORBIDDEN', '只有活动持有人或系统 / 高级管理员可以调整活动授权');
}

export function registerActivityRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerActivityCrud(module, deps);
  registerActivityLifecycle(module, deps);
  registerActivityExtras(module, deps);
}

function registerActivityCrud(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities', (c) =>
    read(c, deps, async (tx, admin) => ({
      items: rows<ActivityRow>(
        await tx.execute(sql`SELECT a.* FROM survey360_activities a WHERE NOT a.deleted AND ${activityVisibleSql(admin)}
          ORDER BY a.created_at, a.id LIMIT 500`),
      ).map(activityView),
    })),
  );
  module.get('/activities/:id', (c) =>
    read(c, deps, async (tx, admin) => activityView(await requireActivity(tx, admin, uuidParam(c)))),
  );
  module.post('/activities', (c) =>
    write(
      c,
      deps,
      createSchema,
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        const [row] = await tx
          .insert(survey360Activities)
          .values({
            tenantId: ctx.tenantId,
            name: input.name,
            scene: input.scene ?? null,
            form: input.form,
            welcome: input.welcome ?? null,
            showAppraiserName: input.showAppraiserName,
            roleDisplay: input.roleDisplay,
            ownerUserId: ctx.userId,
            createdBy: ctx.userId,
          })
          .returning({ id: survey360Activities.id });
        const saved = await reload(tx, row!.id);
        await auditActivity(tx, ctx, 'survey360.activity.create', null, saved);
        return activityView(saved);
      },
      { status: 201 },
    ),
  );
}

function registerActivityLifecycle(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.put('/activities/:id', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      updateSchema,
      async (tx, ctx, input) => {
        const current = await requireActivity(tx, ctx.admin, id, true);
        requireRevision(current.revision, ctx.expectedRevision);
        if (input.form !== undefined && input.form !== current.form && current.status !== 'draft')
          fail('CONFLICT', '评价形式只能在草稿状态修改', 'NOT_DRAFT');
        const saved = await bump(tx, current, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scene !== undefined ? { scene: input.scene } : {}),
          ...(input.form !== undefined ? { form: input.form } : {}),
          ...(input.welcome !== undefined ? { welcome: input.welcome } : {}),
          ...(input.showAppraiserName !== undefined ? { showAppraiserName: input.showAppraiserName } : {}),
          ...(input.roleDisplay !== undefined ? { roleDisplay: input.roleDisplay } : {}),
        });
        await auditActivity(tx, ctx, 'survey360.activity.update', activityView(current), saved);
        return activityView(saved);
      },
      { guard: guarded(id) },
    );
  });
  module.delete('/activities/:id', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        const current = await requireActivity(tx, ctx.admin, id, true);
        requireRevision(current.revision, ctx.expectedRevision);
        if (current.status !== 'draft') fail('CONFLICT', '只有草稿活动可以删除', 'NOT_DRAFT');
        const saved = await bump(tx, current, { deleted: true });
        await auditActivity(tx, ctx, 'survey360.activity.delete', activityView(current), saved);
        return { id, deleted: true };
      },
      { guard: guarded(id) },
    );
  });
  for (const action of ['enable', 'disable'] as const)
    module.post(`/activities/:id/${action}`, (c) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        z.object({}).passthrough(),
        async (tx, ctx) => {
          const current = await requireActivity(tx, ctx.admin, id, true);
          requireRevision(current.revision, ctx.expectedRevision);
          let saved: ActivityRow;
          if (action === 'enable') {
            if (current.status === 'enabled') fail('CONFLICT', '活动已启用', 'ALREADY_ENABLED');
            await markUsed(tx, await checkEnable(tx, id));
            saved = await bump(tx, current, { status: 'enabled', startedAt: current.started_at ? undefined : ctx.now });
            await issueAnswerLinks(tx, ctx, id);
          } else {
            if (current.status !== 'enabled') fail('CONFLICT', '只有启用中的活动可以停用', 'NOT_ENABLED');
            saved = await bump(tx, current, { status: 'disabled', endedAt: ctx.now });
            await computeScores(tx, ctx, id);
            saved = await reload(tx, id);
          }
          await auditActivity(tx, ctx, `survey360.activity.${action}`, activityView(current), saved);
          return activityView(saved);
        },
        { guard: guarded(id) },
      );
    });
}

function registerActivityExtras(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerGrants(module, deps);
  module.get('/activities/:id/objects/:objectId/scores', (c) =>
    read(c, deps, async (tx, admin) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      await requireObject(tx, activity.id, uuidParam(c, 'objectId'));
      return { items: await objectScores(tx, activity.score_batch_id, uuidParam(c, 'objectId')) };
    }),
  );
}

function registerGrants(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/grants', (c) =>
    read(c, deps, async (tx, admin) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      const items = await tx
        .select({ userId: survey360ActivityGrants.userId })
        .from(survey360ActivityGrants)
        .where(eq(survey360ActivityGrants.activityId, activity.id));
      return { userIds: items.map((i) => i.userId).sort() };
    }),
  );
  module.put('/activities/:id/grants', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ userIds: z.array(uuid).max(200) }),
      async (tx, ctx, input) => {
        const current = await requireActivity(tx, ctx.admin, id, true);
        requireManager(ctx.admin, current);
        requireRevision(current.revision, ctx.expectedRevision);
        const userIds = [...new Set(input.userIds)].sort();
        const admins = rows<{ user_id: string }>(
          await tx.execute(sql`SELECT user_id FROM survey360_admins WHERE status = 'active'
            AND user_id = ANY(${`{${userIds.join(',')}}`}::uuid[])`),
        );
        if (admins.length !== userIds.length) fail('VALIDATION_FAILED', '只能授权给 360 管理员', 'NOT_A_360_ADMIN');
        const before = (
          await tx
            .select({ userId: survey360ActivityGrants.userId })
            .from(survey360ActivityGrants)
            .where(eq(survey360ActivityGrants.activityId, id))
        )
          .map((g) => g.userId)
          .sort();
        await tx.delete(survey360ActivityGrants).where(eq(survey360ActivityGrants.activityId, id));
        if (userIds.length)
          await tx
            .insert(survey360ActivityGrants)
            .values(
              userIds.map((userId) => ({ tenantId: ctx.tenantId, activityId: id, userId, createdBy: ctx.userId })),
            );
        await bump(tx, current, {});
        await audit360(tx, actor(ctx), {
          action: 'survey360.activity.grants',
          objectType: 'survey360-activity',
          objectId: id,
          before: { activityId: id, userIds: before },
          after: { activityId: id, userIds },
        });
        return { userIds };
      },
      { guard: guarded(id) },
    );
  });
}
