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
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { activityView, activityVisibleSql, type ActivityRow, requireActivity, requireVisibleObject } from './access.js';
import {
  actor,
  type Admin,
  allActivitiesOf,
  asIs,
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
import { loadQuestionnaire, lockQuestionnaires, markUsed } from './questionnaires.js';
import { computeScores, objectScores } from './scoring.js';

const base = {
  name: text(200),
  scene: optionalText(100),
  form: z.enum(['single', 'multiple']),
  welcome: optionalText(5000),
  showAppraiserName: z.boolean(),
  roleDisplay: z.enum(survey360.ROLE_DISPLAY_MODES),
};
// DEC-280④：作答页默认显示评价者姓名、默认显示评价角色名称（原站新增活动页的默认值）；默认值在命令内补，
// 不算请求写入的字段（字段编辑权按实际载荷判，第 3 轮）
const createSchema = z.strictObject({
  ...base,
  showAppraiserName: base.showAppraiserName.optional(),
  roleDisplay: base.roleDisplay.optional(),
});
const updateSchema = z.strictObject(base).partial();

async function reload(tx: Tx, id: string): Promise<ActivityRow> {
  const [row] = rows<ActivityRow>(await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${id}::uuid`));
  return row!;
}

async function auditActivity(
  tx: Tx,
  ctx: Survey360Context,
  action: string,
  before: unknown,
  after: ActivityRow,
  credentialPending = 0,
) {
  const view = activityView(after);
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-activity',
    objectId: after.id,
    before,
    // 凭据进入待发放只记人数，不记明文与摘要（F-076 设计 §2.6）
    after: { ...view, activityId: after.id, ...(credentialPending ? { credentialPending } : {}) },
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
  // F-053：锁顺序 活动 → 套卷（按 id 升序，见 lockQuestionnaires）。套卷编辑 / 删除只锁套卷（先锁套卷再查“有无启用活动”），
  // 启用若不锁套卷，两边互相看不见对方未提交的写入：编辑提交时活动已启用，或活动按编辑前的内容通过校验。行锁
  // （FOR UPDATE）而非共享锁：随后的 markUsed 要改同一行，共享锁会让两个并发启用互相等待成死锁。
  await lockQuestionnaires(tx, [...used]);
  for (const id of [...used].sort()) {
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

/** 给活动里每位评价者发放作答链接（已有的不重复发放）。返回进入凭据待发放的人数（审计只记人数，设计 §2.6）。 */
export async function issueAnswerLinks(tx: Tx, ctx: Survey360Context, activityId: string): Promise<number> {
  const ids = rows<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT r.appraiser_person_id AS id FROM survey360_relations r
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      WHERE r.activity_id = ${activityId}::uuid AND NOT r.removed ORDER BY 1`),
  );
  let pending = 0;
  for (const { id } of ids) {
    const [person] = await tx.select().from(survey360People).where(eq(survey360People.id, id));
    if ((await ensureAnswerLink(tx, ctx, activityId, person!))?.credentialPending) pending += 1;
  }
  return pending;
}

const VIEW = { object: 'activity' } as const;
const guarded = (id: string) => async (tx: Tx, admin: Admin) => void (await requireActivity(tx, admin, id));
/** 删除命令的命令前校验（含重放）：已删除的活动按删除前的行判定可见。 */
const deletable = (id: string) => async (tx: Tx, admin: Admin) =>
  void (await requireActivity(tx, admin, id, false, true));

export function registerActivityRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerActivityCrud(module, deps);
  registerActivityLifecycle(module, deps);
  registerActivityExtras(module, deps);
}

function registerActivityCrud(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities', (c) =>
    read(c, deps, VIEW, async (tx, admin) => ({
      items: rows<ActivityRow>(
        await tx.execute(sql`SELECT a.* FROM survey360_activities a WHERE NOT a.deleted
            AND ${activityVisibleSql(admin)} ORDER BY a.created_at, a.id LIMIT 500`),
      ).map(activityView),
    })),
  );
  module.get('/activities/:id', (c) =>
    read(c, deps, VIEW, async (tx, admin) => activityView(await requireActivity(tx, admin, uuidParam(c)))),
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
            showAppraiserName: input.showAppraiserName ?? true,
            roleDisplay: input.roleDisplay ?? 'name',
            ownerUserId: ctx.userId,
            createdBy: ctx.userId,
          })
          .returning({ id: survey360Activities.id });
        const saved = await reload(tx, row!.id);
        await auditActivity(tx, ctx, 'survey360.activity.create', null, saved);
        return activityView(saved);
      },
      {
        need: { object: 'activity', operation: 'create' },
        fields: 'body',
        status: 201,
        // 新建活动只用 userId（创建人 / 所有人），不读已有活动的可见范围：不预取“全部活动”（F-075，DEC-369）
        admin: 'identity',
      },
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
      { need: { object: 'activity', operation: 'update' }, fields: 'body', guard: guarded(id) },
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
      { need: { object: 'activity', operation: 'delete' }, fields: 'none', guard: deletable(id) },
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
          let credentialPending = 0;
          if (action === 'enable') {
            if (current.status === 'enabled') fail('CONFLICT', '活动已启用', 'ALREADY_ENABLED');
            await markUsed(tx, await checkEnable(tx, id));
            saved = await bump(tx, current, { status: 'enabled', startedAt: current.started_at ? undefined : ctx.now });
            credentialPending = await issueAnswerLinks(tx, ctx, id);
          } else {
            if (current.status !== 'enabled') fail('CONFLICT', '只有启用中的活动可以停用', 'NOT_ENABLED');
            saved = await bump(tx, current, { status: 'disabled', endedAt: ctx.now });
            await computeScores(tx, ctx, id);
            saved = await reload(tx, id);
          }
          await auditActivity(tx, ctx, `survey360.activity.${action}`, activityView(current), saved, credentialPending);
          return activityView(saved);
        },
        // 状态流转，不写活动字段
        { need: { object: 'activity', operation: 'update', button: action }, fields: 'none', guard: guarded(id) },
      );
    });
}

function registerActivityExtras(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerGrants(module, deps);
  module.get('/activities/:id/objects/:objectId/scores', (c) =>
    read(c, deps, { object: 'result' }, async (tx, admin) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      // 精细化权限下评价对象的人员看不到时按不存在处理（DEC-289①）
      await requireVisibleObject(tx, admin, activity.id, uuidParam(c, 'objectId'));
      return { items: await objectScores(tx, activity.score_batch_id, uuidParam(c, 'objectId')) };
    }),
  );
}

interface Holder {
  readonly user_id: string;
  readonly display_name: string | null;
}

/** 360 身份持有人（有效用户授权里有登记 Survey360 应用的身份、成员有效），带账号显示名。 */
async function holders(tx: Tx): Promise<Holder[]> {
  return rows<Holder>(
    await tx.execute(sql`WITH h AS (SELECT DISTINCT g.user_id FROM permission_grants g
        JOIN permission_profile_apps pa ON pa.tenant_id = g.tenant_id AND pa.profile_id = g.profile_id
        WHERE g.status = 'active' AND pa.app_code = ${survey360.SURVEY360_APP})
      SELECT h.user_id, m.display_name FROM h
      JOIN tenant_memberships tm ON tm.user_id = h.user_id AND tm.status = 'active'
      JOIN tenant_member_accounts(ARRAY(SELECT user_id FROM h)) m ON m.account_id = h.user_id AND m.status = 'active'
      ORDER BY h.user_id LIMIT 2000`),
  );
}

async function explicitGrants(tx: Tx, activityId: string): Promise<string[]> {
  return (
    await tx
      .select({ userId: survey360ActivityGrants.userId })
      .from(survey360ActivityGrants)
      .where(eq(survey360ActivityGrants.activityId, activityId))
  )
    .map((g) => g.userId)
    .sort();
}

/**
 * 活动授权穿梭框（DEC-280③）：已授权栏 = 创建者 + 持“全部活动”者（系统管理员，默认在内）+ 显式授权；未授权栏 =
 * 其余 360 身份持有人。“全部活动”按候选人当前的身份逐个判定（与接口同一判定）。
 */
async function grantsView(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, activity: ActivityRow) {
  const explicit = new Set(await explicitGrants(tx, activity.id));
  const authorized: { userId: string; displayName: string | null; creator: boolean; systemAdmin: boolean }[] = [];
  const unauthorized: { userId: string; displayName: string | null }[] = [];
  for (const h of await holders(tx)) {
    const creator = h.user_id === activity.owner_user_id;
    const systemAdmin = await allActivitiesOf(tx, deps, { ...tenant, userId: h.user_id });
    if (creator || systemAdmin || explicit.has(h.user_id))
      authorized.push({ userId: h.user_id, displayName: h.display_name, creator, systemAdmin });
    else unauthorized.push({ userId: h.user_id, displayName: h.display_name });
  }
  return {
    authorized: authorized.map(({ displayName: _name, ...a }) => ({ ...a, explicit: explicit.has(a.userId) })),
    unauthorized: unauthorized.map((u) => ({ userId: u.userId })),
    names: Object.fromEntries([...authorized, ...unauthorized].map((u) => [u.userId, u.displayName])),
  };
}

async function auditGrants(tx: Tx, ctx: Survey360Context, id: string, before: string[], after: string[]) {
  await audit360(tx, actor(ctx), {
    action: 'survey360.activity.grants',
    objectType: 'survey360-activity',
    objectId: id,
    before: { activityId: id, userIds: before },
    after: { activityId: id, userIds: after },
  });
}

function registerGrants(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 授权区是活动基本信息的一部分：能编辑该活动的人就能改授权（DEC-280③）。两栏是账号信息（用户 ID、标记、
  // 显示名），不是 360 对象字段，不按对象字段裁剪（asIs）；授权名单也不是活动字段，写入不走字段编辑校验
  const EDIT = { object: 'activity', operation: 'update' } as const;
  module.get('/activities/:id/grants', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin, tenant) => grantsView(tx, deps, tenant, await requireActivity(tx, admin, uuidParam(c))),
      asIs,
    ),
  );
  module.post('/activities/:id/grants', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ userIds: z.array(uuid).min(1).max(200) }),
      async (tx, ctx, input) => {
        const current = await requireActivity(tx, ctx.admin, id, true);
        requireRevision(current.revision, ctx.expectedRevision);
        const pool = new Set((await holders(tx)).map((h) => h.user_id));
        const userIds = [...new Set(input.userIds)].sort();
        const outsider = userIds.find((u) => !pool.has(u));
        if (outsider)
          fail('VALIDATION_FAILED', '只能授权给持有 360 身份的用户', 'NOT_A_360_USER', { userId: outsider });
        const before = await explicitGrants(tx, id);
        const added = userIds.filter((u) => !before.includes(u));
        if (added.length)
          await tx
            .insert(survey360ActivityGrants)
            .values(added.map((userId) => ({ tenantId: ctx.tenantId, activityId: id, userId, createdBy: ctx.userId })));
        await bump(tx, current, {});
        const after = await explicitGrants(tx, id);
        await auditGrants(tx, ctx, id, before, after);
        return grantsView(tx, deps, ctx, current);
      },
      { need: EDIT, fields: 'none', guard: guarded(id), present: asIs },
    );
  });
  module.delete('/activities/:id/grants/:userId', (c) => {
    const id = uuidParam(c);
    const userId = uuidParam(c, 'userId');
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        const current = await requireActivity(tx, ctx.admin, id, true);
        requireRevision(current.revision, ctx.expectedRevision);
        const implicit = userId === current.owner_user_id || (await allActivitiesOf(tx, deps, { ...ctx, userId }));
        if (implicit) fail('CONFLICT', '创建者与系统管理员默认已授权，不能移除', 'IMPLICIT_GRANT');
        const before = await explicitGrants(tx, id);
        if (!before.includes(userId)) fail('NOT_FOUND', '该用户未被授权');
        await tx
          .delete(survey360ActivityGrants)
          .where(and(eq(survey360ActivityGrants.activityId, id), eq(survey360ActivityGrants.userId, userId)));
        await bump(tx, current, {});
        await auditGrants(tx, ctx, id, before, await explicitGrants(tx, id));
        return grantsView(tx, deps, ctx, current);
      },
      { need: EDIT, fields: 'none', guard: guarded(id), present: asIs },
    );
  });
}
