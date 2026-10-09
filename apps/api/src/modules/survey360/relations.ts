/**
 * 评价对象与评价关系（docs/02_业务建模/25 §3.3）：
 * - 评价对象：手动录入（姓名 + 邮箱）或选已有人员，1–3 个已启用套卷（E3-R3）；一个活动最多 30,000 个（E3-R16）；
 * - 评价者：每个对象最多 500 个、每个活动最多 50,000 个（E3-R17）；自评的评价者只能是对象本人；
 * - 按组织架构自动添加：上级 = 直线经理、同事 = 同一直线经理的人、下级 = 直接下属，可设各角色人数上限（E3-R18）；
 * - 批量导入评价者：整批成功或整批失败；可选“不同步”（DEC-030 ④）；
 * - 请上级确认（E3-R19）：邀请对象的上级经确认链接设置评价者，确认后前台不可再改，只能管理员后台调整。
 * 「设置评价者」页常驻不拦截提示（DEC-149，AC-360-16）：不按人数拦截，也不隐藏任何角色。
 */
import {
  and,
  eq,
  inArray,
  sql,
  survey360Confirmations,
  survey360Links,
  survey360ObjectQuestionnaires,
  survey360Objects,
  survey360People,
  survey360Relations,
  survey360Roles,
  type Tx,
  withTenant,
} from '@italent/db';
import { survey360, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { personAvatars, type AvatarReference } from '../avatar/references.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { uuidParam } from '../job/context.js';
import type { SQL } from 'drizzle-orm';
import { type ActivityRow, requireActivity, requireObject, requireVisibleObject } from './access.js';
import { roleIdOf } from './settings.js';
import {
  actor,
  type Admin,
  type Also,
  audit360,
  email,
  fail,
  jsonOrEmpty,
  optionalText,
  pick,
  type Present,
  read,
  requireNewObject,
  requireRevision,
  rows,
  type Survey360Context,
  text,
  uuid,
  type Viewer,
  write,
  type Writer,
} from './context.js';
import { ensureAnswerLink, issueConfirmLink } from './links.js';
import {
  createPerson,
  findPersonByEmail,
  loadPerson,
  personFilter,
  personInput,
  type PersonRow,
  personVisible,
  requireCreatable,
  updatePerson,
  visiblePerson,
  visiblePersonIds,
} from './people.js';
import {
  employeeInScope,
  employeesInScope,
  fineEmployees,
  personForEmployee,
  refreshFromOrg,
  restrictedSkips,
  routeEmployeeScope,
  syncAccess,
} from './sync.js';
import type { ModuleScope } from '../permission/module-access.js';
import { loadQuestionnaire, markUsed } from './questionnaires.js';

const LIMITS = survey360.SURVEY360_LIMITS;
const personRef = { personId: uuid.optional(), person: personInput.optional() };

type RelationRow = typeof survey360Relations.$inferSelect;

export function relationView(row: RelationRow) {
  return {
    id: row.id,
    activityId: row.activityId,
    objectId: row.objectId,
    appraiserPersonId: row.appraiserPersonId,
    roleId: row.roleId,
    source: row.source,
    revision: row.revision,
  };
}

async function auditRelation(tx: Tx, ctx: Writer, action: string, before: RelationRow | null, after: RelationRow) {
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-relation',
    objectId: after.id,
    before: before ? relationView(before) : null,
    after: { ...relationView(after), removed: after.removed },
  });
}

type PersonRef = { personId?: string | undefined; person?: z.infer<typeof personInput> | undefined };

/**
 * 载荷引用的人员：选已有人员，或手动录入时按邮箱复用。精细化权限下只能用可见人员：选到看不到的人员 404；录入的
 * 邮箱属于看不到的人员或是新邮箱都一样 403 PERSON_NOT_AVAILABLE（不新建、不暴露存在性，第 3 轮 R2-P2-7）。
 * 返回 undefined = 录入的是新邮箱、可以新建。命令前（含幂等重放，第 4 轮 R3-P2-1）与命令内同一判定。
 */
async function referencedPerson(tx: Tx, admin: Admin, ref: PersonRef): Promise<PersonRow | undefined> {
  if (ref.personId) return visiblePerson(tx, admin, ref.personId);
  if (!ref.person) fail('VALIDATION_FAILED', '须选择人员或录入姓名与邮箱', 'PERSON_REQUIRED');
  const existing = await findPersonByEmail(tx, ref.person.email);
  if (existing && (await personVisible(tx, admin, existing))) return existing;
  requireCreatable(admin);
  return undefined;
}

async function resolvePerson(tx: Tx, ctx: Survey360Context, ref: PersonRef): Promise<PersonRow> {
  return (await referencedPerson(tx, ctx.admin, ref)) ?? createPerson(tx, ctx, ref.person!);
}

/** write() 的载荷资源复核：录入 / 选择的人员按当前范围判定（不新建）。 */
const personRefs = async (tx: Tx, admin: Admin, ref: PersonRef) => void (await referencedPerson(tx, admin, ref));

/**
 * write() 的结果资源复核（第 5 轮 R4-P2-1）：结果里实际的人员（稳定 ID）按当前范围判定。录入的邮箱可能已转给别人，
 * personRefs 判的是邮箱现在的持有人；结果里的人员看不到时与新命令选到看不到的人员同一结果（404），不返回历史结果。
 */
const resultPerson =
  (key: 'personId' | 'appraiserPersonId') =>
  async (tx: Tx, admin: Admin, body: Record<typeof key, string>): Promise<void> =>
    void (await visiblePerson(tx, admin, body[key]));

/** 录入 person 即隐式新建 360 人员：不论邮箱是否已存在都先判人员新增权限与字段（不暴露存在性）。 */
const personAlso = (ref: PersonRef): readonly Also[] =>
  ref.person ? [{ need: { object: 'person', operation: 'create' }, fields: Object.keys(ref.person) }] : [];

async function requireQuestionnaires(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length < 1 || ids.length > LIMITS.questionnairesPerObject)
    fail('VALIDATION_FAILED', '一个评价对象须选 1～3 个套卷', 'TOO_MANY_QUESTIONNAIRES');
  if (new Set(ids).size !== ids.length) fail('VALIDATION_FAILED', '套卷重复', 'DUPLICATE_QUESTIONNAIRE');
  for (const id of ids) {
    const q = await loadQuestionnaire(tx, id);
    // E3-R3：只能选“已启用”的套卷（已使用的同样可用）
    if (q.row.status === 'draft') fail('CONFLICT', '只能选已启用的套卷', 'QUESTIONNAIRE_NOT_ENABLED');
  }
}

async function objectQuestionnaires(tx: Tx, objectId: string): Promise<string[]> {
  return (
    await tx
      .select({ id: survey360ObjectQuestionnaires.questionnaireId })
      .from(survey360ObjectQuestionnaires)
      .where(eq(survey360ObjectQuestionnaires.objectId, objectId))
  ).map((r) => r.id);
}

async function count(tx: Tx, query: ReturnType<typeof sql>): Promise<number> {
  return rows<{ n: number }>(await tx.execute(query))[0]!.n;
}

/** 新增一条评价关系（管理员、导入、自动添加、上级确认共用）：角色、自评、上限与重复校验。 */
export async function addRelation(
  tx: Tx,
  ctx: Writer,
  activity: ActivityRow,
  objectId: string,
  appraiser: PersonRow,
  roleId: string,
  source: 'manual' | 'import' | 'org' | 'confirm',
): Promise<RelationRow> {
  const object = await requireObject(tx, activity.id, objectId);
  const [role] = await tx.select().from(survey360Roles).where(eq(survey360Roles.id, roleId));
  if (!role) fail('VALIDATION_FAILED', '评价角色不存在', 'ROLE_NOT_FOUND');
  const self = role.code === survey360.SELF_ROLE;
  if (self !== (appraiser.id === object.person_id))
    fail('VALIDATION_FAILED', '自评的评价者只能是评价对象本人，本人只能作自评', 'SELF_ROLE_MISMATCH');
  const roles = new Set<string>();
  for (const id of await objectQuestionnaires(tx, objectId))
    (await loadQuestionnaire(tx, id)).model.roles.forEach((r) => roles.add(r.roleId));
  if (!roles.has(roleId)) fail('VALIDATION_FAILED', '评价角色不在评价对象的套卷中', 'ROLE_NOT_IN_QUESTIONNAIRE');
  const perObject = await count(
    tx,
    sql`SELECT count(*)::int AS n FROM survey360_relations WHERE object_id = ${objectId}::uuid AND NOT removed`,
  );
  if (perObject >= LIMITS.appraisersPerObject)
    fail('VALIDATION_FAILED', '一个评价对象最多 500 个评价者', 'TOO_MANY_APPRAISERS');
  const perActivity = await count(
    tx,
    sql`SELECT count(*)::int AS n FROM survey360_relations WHERE activity_id = ${activity.id}::uuid AND NOT removed`,
  );
  if (perActivity >= LIMITS.appraisersPerActivity)
    fail('VALIDATION_FAILED', '一个活动最多 50,000 个评价者', 'TOO_MANY_APPRAISERS');
  const [existing] = await tx
    .select({ id: survey360Relations.id })
    .from(survey360Relations)
    .where(
      and(
        eq(survey360Relations.objectId, objectId),
        eq(survey360Relations.appraiserPersonId, appraiser.id),
        eq(survey360Relations.removed, false),
      ),
    );
  if (existing) fail('CONFLICT', '该评价者已在评价关系中', 'RELATION_EXISTS');
  const [row] = await tx
    .insert(survey360Relations)
    .values({
      tenantId: ctx.tenantId,
      activityId: activity.id,
      objectId,
      appraiserPersonId: appraiser.id,
      roleId,
      source,
    })
    .returning();
  // 启用中的活动新加评价者：发放（或沿用）作答链接
  if (activity.status === 'enabled') await ensureAnswerLink(tx, ctx, activity.id, appraiser);
  await auditRelation(tx, ctx, 'survey360.relation.create', null, row!);
  return row!;
}

export async function removeRelation(tx: Tx, ctx: Writer, relation: RelationRow): Promise<RelationRow> {
  const [saved] = await tx
    .update(survey360Relations)
    .set({ removed: true, revision: relation.revision + 1 })
    .where(eq(survey360Relations.id, relation.id))
    .returning();
  await auditRelation(tx, ctx, 'survey360.relation.remove', relation, saved!);
  return saved!;
}

export async function loadRelation(
  tx: Tx,
  objectId: string,
  id: string,
  lock = false,
  removed = false,
): Promise<RelationRow> {
  const query = tx
    .select()
    .from(survey360Relations)
    .where(
      and(
        eq(survey360Relations.id, id),
        eq(survey360Relations.objectId, objectId),
        removed ? undefined : eq(survey360Relations.removed, false),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) fail('NOT_FOUND', '评价关系不存在');
  return row;
}

/** 精细化权限下评价者（其人员）须可见：看不到与不存在同一结果（DEC-289①）。 */
async function requireVisibleAppraiser(tx: Tx, admin: Admin, relation: RelationRow): Promise<void> {
  if (admin.people && !(await personVisible(tx, admin, await loadPerson(tx, relation.appraiserPersonId))))
    fail('NOT_FOUND', '评价关系不存在');
}

/** 列表 SQL 的人员谓词（别名 p），精细化未生效时为空。 */
function filterOf(admin: Admin): SQL {
  const filter = personFilter(admin);
  return filter ? sql`AND ${filter}` : sql``;
}

/**
 * 某评价对象的评价者列表与各角色人数（「设置评价者」页）。filter = 精细化权限下的人员谓词（别名 p）：只列可见的
 * 评价者，各角色人数只按列出的计（DEC-289①）。
 */
export async function appraiserList(tx: Tx, objectId: string, filter: SQL | null = null) {
  const items = rows<{
    id: string;
    activity_id: string;
    object_id: string;
    appraiser_person_id: string;
    role_id: string;
    role_name: string;
    source: string;
    revision: number;
    name: string;
    email: string;
    employee_id: string | null;
  }>(
    await tx.execute(sql`SELECT r.*, ro.name AS role_name, p.name, p.email, p.employee_id FROM survey360_relations r
      JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id
      JOIN survey360_people p ON p.tenant_id = r.tenant_id AND p.id = r.appraiser_person_id
      WHERE r.object_id = ${objectId}::uuid AND NOT r.removed ${filter ? sql`AND ${filter}` : sql``}
      ORDER BY ro.sort, r.created_at, r.id`),
  ).map((r) => ({
    id: r.id,
    activityId: r.activity_id,
    objectId: r.object_id,
    appraiserPersonId: r.appraiser_person_id,
    appraiser: { name: r.name, email: r.email, internal: r.employee_id !== null },
    roleId: r.role_id,
    roleName: r.role_name,
    source: r.source,
    revision: r.revision,
  }));
  const roleCounts: Record<string, number> = {};
  for (const item of items) roleCounts[item.roleId] = (roleCounts[item.roleId] ?? 0) + 1;
  return { items, roleCounts, hint: survey360.ANONYMITY_HINT };
}

/** 嵌套人员的键 → 人员对象字段（internal 由挂接员工推得，随 employeeId）。 */
const NESTED_PERSON = { internal: 'employeeId' };

/**
 * 行按评价关系字段裁剪；嵌套人员（person / appraiser）要评价关系上该字段可见，且键按查看人的人员字段裁剪——没有
 * 人员对象时一个键都不给（不因权限更少而看到更多，第 3 轮 R2-P2-3）。
 */
async function withNested(viewer: Viewer, rows: readonly Record<string, unknown>[], key: 'person' | 'appraiser') {
  const relation = await viewer.fields('relation');
  const person = await viewer.fields('person');
  const personKey = key === 'person' ? 'personId' : 'appraiserPersonId';
  // 只为已允许出现姓名的嵌套人员补头像；人员详情范围与匿名作答页授权不在这里放宽。
  const showAvatar = (!relation || relation.has(key)) && (!person || person.has('name'));
  const avatars = showAvatar
    ? await personAvatars(
        viewer.tx,
        viewer.tenant.tenantId,
        rows.flatMap((row) => (typeof row[personKey] === 'string' ? [row[personKey] as string] : [])),
      )
    : new Map<string, AvatarReference | null>();
  return rows.map((row) => {
    const trimmed = pick(row, relation);
    const inner = trimmed[key] ? pick(trimmed[key] as object, person, NESTED_PERSON) : {};
    const { [key]: _nested, ...rest } = trimmed;
    const shown = 'name' in inner ? { ...inner, avatar: avatars.get(row[personKey] as string) ?? null } : inner;
    return Object.keys(shown).length ? { ...rest, [key]: shown } : rest;
  });
}

const objectList: Present = async (viewer, body: { items: Record<string, unknown>[] }) => ({
  items: await withNested(viewer, body.items, 'person'),
});

/** 评价者列表：roleCounts 以角色 ID 为键，只在查看人能看评价关系的 roleId 时返回（第 3 轮 R2-P2-3）。 */
const appraiserListView: Present = async (viewer, body: Awaited<ReturnType<typeof appraiserList>>) => {
  const relation = await viewer.fields('relation');
  const items = await withNested(viewer, body.items, 'appraiser');
  return { items, ...(!relation || relation.has('roleId') ? { roleCounts: body.roleCounts } : {}), hint: body.hint };
};

const VIEW = { object: 'relation' } as const;
const guarded = (id: string) => async (tx: Tx, admin: Admin) => void (await requireActivity(tx, admin, id));
/** 活动可见 + 评价对象（其人员）可见；removed = 移除命令的命令前校验（含重放）。 */
const objectGuard =
  (id: string, objectId: string, removed = false) =>
  async (tx: Tx, admin: Admin) => {
    await requireActivity(tx, admin, id);
    await requireVisibleObject(tx, admin, id, objectId, false, removed);
  };

function registerAppraiserList(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/objects/:objectId/appraisers', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin) => {
        const activity = await requireActivity(tx, admin, uuidParam(c));
        const object = await requireVisibleObject(tx, admin, activity.id, uuidParam(c, 'objectId'));
        return appraiserList(tx, object.id, personFilter(admin));
      },
      appraiserListView,
    ),
  );
}

export function registerRelationRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerObjects(module, deps);
  registerAppraiserList(module, deps);
  module.post('/activities/:id/objects/:objectId/appraisers', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    return write(
      c,
      deps,
      z.strictObject({ ...personRef, roleId: uuid }),
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        const activity = await requireActivity(tx, ctx.admin, id, true);
        await requireVisibleObject(tx, ctx.admin, id, objectId);
        const appraiser = await resolvePerson(tx, ctx, input);
        return relationView(await addRelation(tx, ctx, activity, objectId, appraiser, input.roleId, 'manual'));
      },
      {
        need: { object: 'relation', operation: 'create' },
        // 选人写 appraiserPersonId，录入写 appraiser（并隐式新建人员）
        fields: (input) => [input.personId ? 'appraiserPersonId' : 'appraiser', 'roleId'],
        also: personAlso,
        guard: objectGuard(id, objectId),
        refs: personRefs,
        results: resultPerson('appraiserPersonId'),
        status: 201,
      },
    );
  });
  module.delete('/activities/:id/objects/:objectId/appraisers/:relationId', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    const relationId = uuidParam(c, 'relationId');
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        await requireActivity(tx, ctx.admin, id, true);
        await requireVisibleObject(tx, ctx.admin, id, objectId);
        const relation = await loadRelation(tx, objectId, relationId, true);
        await requireVisibleAppraiser(tx, ctx.admin, relation);
        requireRevision(relation.revision, ctx.expectedRevision);
        return relationView(await removeRelation(tx, ctx, relation));
      },
      {
        need: { object: 'relation', operation: 'delete' },
        fields: 'none',
        guard: async (tx, admin) => {
          await objectGuard(id, objectId, true)(tx, admin);
          await requireVisibleAppraiser(tx, admin, await loadRelation(tx, objectId, relationId, false, true));
        },
      },
    );
  });
  registerAutoAdd(module, deps);
  registerImport(module, deps);
  registerConfirmationInvite(module, deps);
}

function registerAutoAdd(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/activities/:id/objects/:objectId/appraisers/auto', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    const ORG_ROLES = ['superior', 'peer', 'subordinate'] as const;
    let employees: ModuleScope | undefined;
    return write(
      c,
      deps,
      z.strictObject({
        roles: z.array(z.enum(ORG_ROLES)).min(1).max(3),
        limits: z.partialRecord(z.enum(ORG_ROLES), z.int().min(0).max(LIMITS.appraisersPerObject)).optional(),
      }),
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        const activity = await requireActivity(tx, ctx.admin, id, true);
        const object = await requireVisibleObject(tx, ctx.admin, id, objectId);
        return autoAdd(tx, deps, ctx, activity, object, input);
      },
      {
        need: { object: 'relation', operation: 'create', button: 'autoAdd' },
        fields: () => ['appraiserPersonId', 'roleId'],
        // 未同步的员工按同步规则新建 360 人员：先判人员新增权限与同步写入的字段
        also: () => [{ need: { object: 'person', operation: 'create' }, fields: SYNCED_PERSON_FIELDS }],
        guard: objectGuard(id, objectId),
        // 命令前（含幂等重放）同样校验评价对象的员工仍在操作人范围内（第 1 轮审查 P2-2 / P2-4）
        preflight: async (admin) => {
          employees = await routeEmployeeScope(c, deps);
          await withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
            await requireActivity(tx, admin, id);
            await requireTargetInScope(tx, employees!, (await requireObject(tx, id, objectId)).person_id);
          });
        },
        // 返回前（新请求与重放同一路径）按当前员工范围与精细化范围去掉范围外的新增与跳过（第 3 轮 R2-P2-1）
        present: async (viewer, body: AutoAddResult) => autoAddView(viewer, employees!, body),
      },
    );
  });
}

function registerObjects(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerObjectList(module, deps);
  registerObjectCreation(module, deps);
  registerObjectChanges(module, deps);
}

function registerObjectList(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/objects', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin) => {
        const activity = await requireActivity(tx, admin, uuidParam(c));
        const items = rows<{
          id: string;
          person_id: string;
          name: string;
          email: string;
          questionnaire_ids: string[] | null;
          revision: number;
        }>(
          await tx.execute(sql`SELECT o.id, o.person_id, o.revision, p.name, p.email,
            (SELECT array_agg(oq.questionnaire_id ORDER BY oq.id) FROM survey360_object_questionnaires oq
              WHERE oq.tenant_id = o.tenant_id AND oq.object_id = o.id) AS questionnaire_ids
          FROM survey360_objects o JOIN survey360_people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id
          WHERE o.activity_id = ${activity.id}::uuid AND NOT o.removed ${filterOf(admin)}
          ORDER BY o.sort, o.created_at, o.id`),
        );
        return {
          items: items.map((o) => ({
            id: o.id,
            personId: o.person_id,
            person: { name: o.name, email: o.email },
            questionnaireIds: (o.questionnaire_ids ?? []).sort(),
            revision: o.revision,
          })),
        };
      },
      objectList,
    ),
  );
}

function registerObjectCreation(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/activities/:id/objects', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ ...personRef, questionnaireIds: z.array(uuid).max(10) }),
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        const activity = await requireActivity(tx, ctx.admin, id, true);
        const count = rows<{ n: number }>(
          await tx.execute(
            sql`SELECT count(*)::int AS n FROM survey360_objects WHERE activity_id = ${id}::uuid AND NOT removed`,
          ),
        )[0]!.n;
        if (count >= LIMITS.objectsPerActivity)
          fail('VALIDATION_FAILED', '一个活动最多 30,000 个评价对象', 'TOO_MANY_OBJECTS');
        await requireQuestionnaires(tx, input.questionnaireIds);
        const person = await resolvePerson(tx, ctx, input);
        const [row] = await tx
          .insert(survey360Objects)
          .values({ tenantId: ctx.tenantId, activityId: id, personId: person.id, sort: count })
          .returning();
        await tx
          .insert(survey360ObjectQuestionnaires)
          .values(
            input.questionnaireIds.map((q) => ({ tenantId: ctx.tenantId, objectId: row!.id, questionnaireId: q })),
          );
        if (activity.status === 'enabled') await markUsed(tx, input.questionnaireIds);
        const view = objectView(row!, input.questionnaireIds);
        await audit360(tx, actor(ctx), {
          action: 'survey360.object.create',
          objectType: 'survey360-object',
          objectId: row!.id,
          before: null,
          after: { ...view, activityId: id },
        });
        return view;
      },
      {
        need: { object: 'relation', operation: 'create' },
        fields: 'body', // personId / person、questionnaireIds
        also: personAlso,
        guard: guarded(id),
        refs: personRefs,
        results: resultPerson('personId'),
        status: 201,
      },
    );
  });
}

function registerObjectChanges(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerObjectQuestionnaires(module, deps);
  registerObjectRemoval(module, deps);
}

function registerObjectQuestionnaires(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.put('/activities/:id/objects/:objectId/questionnaires', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    return write(
      c,
      deps,
      z.strictObject({ questionnaireIds: z.array(uuid).max(10) }),
      async (tx, ctx, input) => {
        const activity = await requireActivity(tx, ctx.admin, id, true);
        const object = await requireVisibleObject(tx, ctx.admin, id, objectId, true);
        requireRevision(object.revision, ctx.expectedRevision);
        await requireQuestionnaires(tx, input.questionnaireIds);
        // 替换套卷会清空已有作答（E3-R2）——首版不做，已有答卷时拒绝
        const sheets = await count(
          tx,
          sql`SELECT count(*)::int AS n FROM survey360_sheets s JOIN survey360_relations r
            ON r.tenant_id = s.tenant_id AND r.id = s.relation_id WHERE r.object_id = ${objectId}::uuid`,
        );
        if (sheets > 0) fail('CONFLICT', '评价对象已有作答，不能更换套卷', 'ANSWERS_EXIST');
        const before = await objectQuestionnaires(tx, objectId);
        await tx.delete(survey360ObjectQuestionnaires).where(eq(survey360ObjectQuestionnaires.objectId, objectId));
        await tx
          .insert(survey360ObjectQuestionnaires)
          .values(input.questionnaireIds.map((q) => ({ tenantId: ctx.tenantId, objectId, questionnaireId: q })));
        if (activity.status === 'enabled') await markUsed(tx, input.questionnaireIds);
        const [saved] = await tx
          .update(survey360Objects)
          .set({ revision: object.revision + 1 })
          .where(eq(survey360Objects.id, objectId))
          .returning();
        const view = objectView(saved!, input.questionnaireIds);
        await audit360(tx, actor(ctx), {
          action: 'survey360.object.questionnaires',
          objectType: 'survey360-object',
          objectId,
          before: { questionnaireIds: before.sort(), activityId: id },
          after: { ...view, activityId: id },
        });
        return view;
      },
      { need: { object: 'relation', operation: 'update' }, fields: 'body', guard: objectGuard(id, objectId) },
    );
  });
}

function registerObjectRemoval(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.delete('/activities/:id/objects/:objectId', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        await requireActivity(tx, ctx.admin, id, true);
        const object = await requireVisibleObject(tx, ctx.admin, id, objectId, true);
        requireRevision(object.revision, ctx.expectedRevision);
        const relations = await tx
          .select()
          .from(survey360Relations)
          .where(and(eq(survey360Relations.objectId, objectId), eq(survey360Relations.removed, false)));
        for (const relation of relations) await removeRelation(tx, ctx, relation);
        // 对象移除后，邀请上级确认的确认单作废、确认链接失效
        await tx
          .update(survey360Confirmations)
          .set({ status: 'cancelled', revision: sql`${survey360Confirmations.revision} + 1` })
          .where(
            and(eq(survey360Confirmations.objectId, objectId), sql`${survey360Confirmations.status} <> 'cancelled'`),
          );
        await tx
          .update(survey360Links)
          .set({ revoked: true })
          .where(
            and(
              eq(survey360Links.kind, 'confirm'),
              sql`${survey360Links.confirmationId} IN (SELECT id FROM
            survey360_confirmations WHERE object_id = ${objectId}::uuid)`,
            ),
          );
        await tx
          .update(survey360Objects)
          .set({ removed: true, revision: object.revision + 1 })
          .where(eq(survey360Objects.id, objectId));
        await audit360(tx, actor(ctx), {
          action: 'survey360.object.remove',
          objectType: 'survey360-object',
          objectId,
          before: { id: objectId, personId: object.person_id, activityId: id },
          after: { id: objectId, removed: true, activityId: id },
        });
        return { id: objectId, removed: true };
      },
      { need: { object: 'relation', operation: 'delete' }, fields: 'none', guard: objectGuard(id, objectId, true) },
    );
  });
}

function objectView(row: typeof survey360Objects.$inferSelect, questionnaireIds: readonly string[]) {
  return {
    id: row.id,
    activityId: row.activityId,
    personId: row.personId,
    questionnaireIds: [...questionnaireIds].sort(),
    revision: row.revision,
  };
}

/** 任职记录上当前直线经理为 managerId 的员工（同事 / 下级）。 */
async function reportsOf(tx: Tx, tenantId: string, managerId: string, asOf: string): Promise<string[]> {
  return rows<{ employee_id: string }>(
    await tx.execute(sql`SELECT t.employee_id FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
      JOIN employment_employees e ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
      LEFT JOIN LATERAL (SELECT p.id, p.direct_manager_id FROM employment_payload_versions p
        WHERE p.tenant_id = r.tenant_id AND p.employee_id = r.employee_id AND p.business_id = r.id
          AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1) latest ON true
      WHERE t.tenant_id = ${tenantId}::uuid AND t.valid_during @> ${asOf}::date
        AND r.kind NOT IN ('leave', 'retirement') AND r.service_type = 'primary'
        AND (CASE WHEN latest.id IS NULL THEN r.direct_manager_id ELSE latest.direct_manager_id END)
          = ${managerId}::uuid
      ORDER BY e.code, e.id`),
  ).map((r) => r.employee_id);
}

/** 按组织架构添加以评价对象的员工为起点：该员工须在操作人当前员工范围内，否则按不存在处理（404）。 */
async function requireTargetInScope(tx: Tx, scope: ModuleScope, personId: string) {
  const target = await loadPerson(tx, personId);
  if (!target.employeeId || !(await employeeInScope(tx, scope, target.employeeId)))
    fail('NOT_FOUND', '评价对象的员工不存在或不在你的数据范围内');
}

/** 自动添加为未同步员工新建 360 人员时写入的人员字段（同步规则，只写操作人可见的组织值）。 */
const SYNCED_PERSON_FIELDS = ['name', 'email', 'mobile', 'staffCode', 'department', 'position', 'superiorPersonId'];

interface AutoAddResult {
  readonly added: ReturnType<typeof relationView>[];
  readonly skipped: { employeeId: string; reason: string }[];
}

/** 候选员工在精细化权限下是否可见：已有 360 人员按人员判，尚未同步的按员工判（DEC-289①；与回执同一函数）。 */
async function candidateVisible(tx: Tx, admin: Admin, employeeId: string): Promise<boolean> {
  const fine = await fineEmployees(tx, admin, [employeeId]);
  return !fine || fine.has(employeeId);
}

/**
 * 自动添加回执：返回前（新请求与重放同一路径）按当前员工范围与精细化范围复核，移出范围的员工的新增关系与跳过
 * 原因都去掉（第 3 轮 R2-P2-1）；新增关系按评价关系字段裁剪。精细化下受限查看人的跳过原因一律
 * PERSON_NOT_AVAILABLE，与其新命令同一口径，不带出查重冲突（第 6 轮 R5-P2-1）。按批查询（有界：一个对象最多 500
 * 个评价者）。
 */
async function autoAddView(viewer: Viewer, employees: ModuleScope, body: AutoAddResult) {
  const { tx, admin } = viewer;
  const personIds = body.added.map((r) => r.appraiserPersonId);
  const linked = personIds.length
    ? await tx
        .select({ id: survey360People.id, employeeId: survey360People.employeeId })
        .from(survey360People)
        .where(inArray(survey360People.id, personIds))
    : [];
  const employeeOf = new Map(linked.map((p) => [p.id, p.employeeId ?? '']));
  const skippedIds = body.skipped.map((s) => s.employeeId);
  const inScope = await employeesInScope(tx, employees, [...employeeOf.values(), ...skippedIds].filter(Boolean));
  const visible = await visiblePersonIds(tx, admin, personIds);
  // 跳过的员工：精细化权限下与命令内选候选同一判定（已挂接的按人员，尚未挂接的按员工，第 5 轮）
  const fine = (await fineEmployees(tx, admin, skippedIds)) ?? new Set(skippedIds);
  const fields = await viewer.fields('relation');
  return {
    added: body.added
      .filter((r) => inScope.has(employeeOf.get(r.appraiserPersonId) ?? '') && visible.has(r.appraiserPersonId))
      .map((row) => pick(row, fields)),
    skipped: restrictedSkips(
      admin,
      body.skipped.filter((s) => inScope.has(s.employeeId) && fine.has(s.employeeId)),
    ),
  };
}

/** 邀请上级确认的回执：按评价关系字段裁剪；精细化权限下确认人（上级）看不到时去掉 confirmerPersonId。 */
const confirmationPresent: Present = async (viewer, body: ReturnType<typeof confirmationView>) => {
  const view = pick(body, await viewer.fields('relation'));
  if (!viewer.admin.people || !('confirmerPersonId' in view)) return view;
  if (await personVisible(viewer.tx, viewer.admin, await loadPerson(viewer.tx, body.confirmerPersonId))) return view;
  const { confirmerPersonId: _hidden, ...rest } = view;
  return rest;
};

async function autoAdd(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: Survey360Context,
  activity: ActivityRow,
  object: { id: string; person_id: string },
  input: { roles: ('superior' | 'peer' | 'subordinate')[]; limits?: Partial<Record<string, number>> | undefined },
): Promise<AutoAddResult> {
  const target = await loadPerson(tx, object.person_id);
  if (!target.employeeId) fail('VALIDATION_FAILED', '评价对象未与组织员工挂接，不能按组织架构添加', 'NOT_LINKED');
  const access = await syncAccess(tx, deps, ctx);
  await requireTargetInScope(tx, access.scope, target.id);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await findCurrentRecord(tx, ctx.tenantId, target.employeeId, asOf);
  const managerId = (record?.fields as unknown as Record<string, unknown> | undefined)?.directManagerId;
  const manager = typeof managerId === 'string' ? managerId : null;
  const candidates: Record<string, string[]> = {
    superior: manager ? [manager] : [],
    peer: manager ? (await reportsOf(tx, ctx.tenantId, manager, asOf)).filter((e) => e !== target.employeeId) : [],
    subordinate: await reportsOf(tx, ctx.tenantId, target.employeeId, asOf),
  };
  const added: ReturnType<typeof relationView>[] = [];
  const skipped: { employeeId: string; reason: string }[] = [];
  for (const code of input.roles) {
    const roleId = await roleIdOf(tx, code);
    let taken = 0;
    const limit = input.limits?.[code];
    for (const employeeId of candidates[code]!) {
      if (limit !== undefined && taken >= limit) break;
      // 精细化权限下候选员工另须在 360 范围内：范围外不建人员、不加关系、不出现在结果里（DEC-289①）
      if (!(await candidateVisible(tx, ctx.admin, employeeId))) continue;
      const person = await personForEmployee(tx, ctx, access, employeeId);
      if (typeof person === 'string') {
        // 范围外的员工不同步，也不在结果里出现
        if (person !== 'OUT_OF_SCOPE') skipped.push({ employeeId, reason: person });
        continue;
      }
      const [existing] = await tx
        .select({ id: survey360Relations.id })
        .from(survey360Relations)
        .where(
          and(
            eq(survey360Relations.objectId, object.id),
            eq(survey360Relations.appraiserPersonId, person.id),
            eq(survey360Relations.removed, false),
          ),
        );
      if (existing) continue;
      added.push(relationView(await addRelation(tx, ctx, activity, object.id, person, roleId, 'org')));
      taken += 1;
    }
  }
  return { added, skipped };
}

const importRow = z.strictObject({
  objectEmail: email,
  roleId: uuid,
  name: text(100),
  email,
  mobile: optionalText(50),
  staffCode: optionalText(100),
  department: optionalText(200),
  position: optionalText(200),
});

type ImportInput = { sync: boolean; rows: z.infer<typeof importRow>[] };

/** 导入行里的人员字段（行内除评价对象邮箱、角色外的键）。 */
const importedPersonFields = (input: ImportInput) =>
  [...new Set(input.rows.flatMap((row) => Object.keys(row)))].filter((key) => !['objectEmail', 'roleId'].includes(key));

/**
 * 导入隐式写人员：新邮箱新建人员（人员新增）；不同步时已有人员以上传值覆盖（人员编辑，邮箱不变）。不论邮箱是否
 * 已存在都先判，不暴露存在性。
 */
function importAlso(input: ImportInput): readonly Also[] {
  const fields = importedPersonFields(input);
  const create: Also = { need: { object: 'person', operation: 'create' }, fields };
  if (input.sync) return [create];
  return [create, { need: { object: 'person', operation: 'update' }, fields: fields.filter((f) => f !== 'email') }];
}

/**
 * 整批校验（AGENTS.md §10「批量」）：评价对象须在活动内且可见；精细化权限下行内人员须是可见的已有人员。
 * removed = 命令前（含幂等重放）的范围复核：已移除的评价对象按移除前判定可见，重放仍返回原回执（第 4 轮 R3-P2-1）。
 */
async function importErrors(tx: Tx, admin: Admin, activityId: string, input: ImportInput, removed = false) {
  const errors: { row: number; code: string; details: { reason: string } }[] = [];
  const objects = new Map<number, string>();
  const error = (index: number, reason: string) =>
    errors.push({ row: index + 1, code: 'VALIDATION_FAILED', details: { reason } });
  for (const [index, row] of input.rows.entries()) {
    const [object] = rows<{ id: string }>(
      await tx.execute(sql`SELECT o.id FROM survey360_objects o JOIN survey360_people p
        ON p.tenant_id = o.tenant_id AND p.id = o.person_id
        WHERE o.activity_id = ${activityId}::uuid ${removed ? sql`` : sql`AND NOT o.removed`}
          AND lower(p.email) = lower(${row.objectEmail}) ${filterOf(admin)} LIMIT 1`),
    );
    if (!object) error(index, 'OBJECT_NOT_FOUND');
    else objects.set(index, object.id);
    // 看不到的已有人员与新邮箱同一原因（不新建、不暴露存在性，第 3 轮 R2-P2-7）
    if (admin.people) {
      const existing = await findPersonByEmail(tx, row.email);
      if (!existing || !(await personVisible(tx, admin, existing))) error(index, 'PERSON_NOT_AVAILABLE');
    }
  }
  return { errors, objects };
}

function requireValidImport(errors: { row: number; code: string; details: { reason: string } }[]): void {
  if (errors.length) fail('VALIDATION_FAILED', '导入数据有误，整批未导入', 'IMPORT_INVALID', { errors });
}

/**
 * 导入的载荷资源复核（第 4 轮 R3-P2-1）：精细化权限生效时，每行的评价对象与评价者按当前人员范围判定，与命令内同一
 * 校验、同一回执；未生效时人员不受范围约束，整批校验只在命令内做。
 */
const importRefs = (activityId: string) => async (tx: Tx, admin: Admin, input: ImportInput) => {
  if (admin.people) requireValidImport((await importErrors(tx, admin, activityId, input, true)).errors);
};

/**
 * 导入的结果复核（第 5 轮 R4-P2-1）：按回执里的评价关系（稳定 ID，含之后被移除的）取实际的评价对象与评价者，逐条
 * 按当前人员范围判定——邮箱可能已转给别人，importRefs 按载荷邮箱解析的是现在的持有人。看不到的行与命令前同一回执：
 * 整批 400 IMPORT_INVALID，逐行 OBJECT_NOT_FOUND / PERSON_NOT_AVAILABLE；精细化未生效时人员不受范围约束。
 */
async function importResults(tx: Tx, admin: Admin, body: { receipts: { row: number; relationId: string }[] }) {
  if (!admin.people || body.receipts.length === 0) return;
  const ids = body.receipts.map((r) => r.relationId);
  const found = rows<{ id: string; object_person: string; appraiser: string }>(
    await tx.execute(sql`SELECT r.id, o.person_id AS object_person, r.appraiser_person_id AS appraiser
      FROM survey360_relations r JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id
      WHERE r.id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  const relations = new Map(found.map((r) => [r.id, r]));
  const visible = await visiblePersonIds(
    tx,
    admin,
    found.flatMap((r) => [r.object_person, r.appraiser]),
  );
  const errors: { row: number; code: string; details: { reason: string } }[] = [];
  const error = (row: number, reason: string) => errors.push({ row, code: 'VALIDATION_FAILED', details: { reason } });
  for (const { row, relationId } of body.receipts) {
    const relation = relations.get(relationId);
    if (!relation || !visible.has(relation.object_person)) error(row, 'OBJECT_NOT_FOUND');
    if (relation && !visible.has(relation.appraiser)) error(row, 'PERSON_NOT_AVAILABLE');
  }
  requireValidImport(errors);
}

/** 导入回执：行号与处理状态是协议键，关系 ID 按评价关系的 id 字段裁剪（不再原样返回，第 4 轮 R3-P2-1）。 */
const importView: Present = async (
  viewer,
  body: { receipts: { row: number; status: string; relationId: string }[] },
) => {
  const fields = await viewer.fields('relation');
  return {
    receipts: body.receipts.map(({ relationId, ...receipt }) =>
      !fields || fields.has('id') ? { ...receipt, relationId } : receipt,
    ),
  };
};

function registerImport(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/activities/:id/appraisers/import', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ sync: z.boolean(), rows: z.array(importRow).min(1).max(LIMITS.importRows) }),
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        const activity = await requireActivity(tx, ctx.admin, id, true);
        // 先整批校验，再写入：任一行不合法整批失败（AGENTS.md §10「批量」）
        const { errors, objects } = await importErrors(tx, ctx.admin, id, input);
        requireValidImport(errors);
        const receipts = [];
        let access: Awaited<ReturnType<typeof syncAccess>> | undefined;
        for (const [index, row] of input.rows.entries()) {
          const { objectEmail: _object, roleId, ...fields } = row;
          void _object;
          let person = await findPersonByEmail(tx, fields.email);
          if (!person) person = await createPerson(tx, ctx, fields, 'import');
          // 同步：已挂接人员按组织员工刷新（DEC-030 ④，第 1 轮审查 P2-6）；不同步：以上传信息为准
          else if (input.sync)
            person = await refreshFromOrg(tx, ctx, (access ??= await syncAccess(tx, deps, ctx)), person);
          else {
            const current = await loadPerson(tx, person.id, true);
            const { email: _email, ...rest } = fields;
            void _email;
            person = await updatePerson(tx, ctx, current, rest, 'survey360.person.import_update');
          }
          const relation = await addRelation(tx, ctx, activity, objects.get(index)!, person, roleId, 'import');
          receipts.push({ row: index + 1, status: 'created', relationId: relation.id });
        }
        return { receipts };
      },
      {
        need: { object: 'relation', operation: 'create', button: 'import' },
        fields: () => ['appraiser', 'roleId'],
        also: importAlso,
        guard: guarded(id),
        refs: importRefs(id),
        results: importResults,
        // 选择“同步”时需要员工信息查看权：命令前（含幂等重放）同样校验
        preflight: async () => {
          const body = (await jsonOrEmpty(c)) as { sync?: unknown } | null;
          if (body?.sync === true) await routeEmployeeScope(c, deps);
        },
        present: importView,
      },
    );
  });
}

function registerConfirmationInvite(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/activities/:id/objects/:objectId/confirmation', (c) => {
    const id = uuidParam(c);
    const objectId = uuidParam(c, 'objectId');
    return write(
      c,
      deps,
      z.strictObject({}),
      async (tx, ctx) => {
        requireNewObject(ctx);
        const activity = await requireActivity(tx, ctx.admin, id, true);
        if (activity.status === 'disabled') fail('CONFLICT', '活动已停用', 'ACTIVITY_DISABLED');
        const object = await requireVisibleObject(tx, ctx.admin, id, objectId, true);
        const target = await loadPerson(tx, object.person_id);
        if (!target.superiorPersonId) fail('VALIDATION_FAILED', '评价对象没有上级，不能邀请上级确认', 'NO_SUPERIOR');
        const superior = await loadPerson(tx, target.superiorPersonId);
        const [open] = await tx
          .select({ id: survey360Confirmations.id })
          .from(survey360Confirmations)
          .where(
            and(
              eq(survey360Confirmations.objectId, objectId),
              inArray(survey360Confirmations.status, ['pending', 'confirmed']),
            ),
          );
        if (open) fail('CONFLICT', '已邀请确认', 'CONFIRMATION_EXISTS');
        const [row] = await tx
          .insert(survey360Confirmations)
          .values({ tenantId: ctx.tenantId, activityId: id, objectId, confirmerPersonId: superior.id })
          .returning();
        await issueConfirmLink(tx, ctx, id, row!.id, superior);
        const view = confirmationView(row!);
        await audit360(tx, actor(ctx), {
          action: 'survey360.confirmation.create',
          objectType: 'survey360-confirmation',
          objectId: row!.id,
          before: null,
          after: { ...view, activityId: id },
        });
        return view;
      },
      {
        need: { object: 'relation', operation: 'update', button: 'invite' },
        fields: () => ['confirmerPersonId'], // 邀请即设置确认人（评价对象的上级）
        guard: objectGuard(id, objectId),
        present: confirmationPresent,
        status: 201,
      },
    );
  });
}

export function confirmationView(row: typeof survey360Confirmations.$inferSelect) {
  return {
    id: row.id,
    activityId: row.activityId,
    objectId: row.objectId,
    confirmerPersonId: row.confirmerPersonId,
    status: row.status,
    revision: row.revision,
  };
}
