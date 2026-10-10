/**
 * 作答与上级确认的链接入口（/api/survey360/link）：评价者（含外部人员，DEC-027）凭邀请邮件中的链接作答，
 * 无需租户账号。租户取 X-Tenant-Id，令牌取 X-Survey360-Token（只存摘要）；租户不可用、令牌无效、或访问不属于
 * 该链接的评价关系，一律 404，不泄露活动、对象或其他评价者是否存在。
 * 匿名开关（DEC-149）：作答页按活动设置决定是否给出评价者姓名与评价角色——关闭时对应键缺席，不是空值。
 * 作答页每次保存为草稿（断点续答，E3-R22），提交后不可再改；优秀率控制只在“一次评价多人”时生效（E3-R9）。
 * PR-B：站内待办“去处理”由登录账号本人进入同一套作答页面与命令（todos.ts 的入口只换“怎么找到链接”）；
 * 两个入口的写入操作人都记为“系统”，审计不留评价者账号。评价者提交全部评价对象后，其待办自动“已处理”。
 */
import {
  and,
  eq,
  getTenant,
  isUuid,
  sql,
  survey360Answers,
  survey360Confirmations,
  survey360Sheets,
  type Tx,
  withTenant,
} from '@italent/db';
import { survey360 } from '@italent/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { handleError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { revision, uuidParam } from '../job/context.js';
import { requireObject, type ActivityRow } from './access.js';
import { ownAnswers, ownSheet, ownSheetTotal } from './anonymous.js';
import type { AvatarReference } from '../avatar/references.js';
import { linkAvatarContent, linkAvatars } from './avatar-links.js';
import {
  actor,
  audit360,
  type C,
  fail,
  jsonOrEmpty,
  mapDbError,
  parse,
  requireRevision,
  rows,
  uuid,
  type Writer,
} from './context.js';
import { findLink, type LinkRow } from './links.js';
import { hasTask, type TaskRow, taskQuery } from './tasks.js';
import { completeTodo } from './todos.js';
import { createPerson, findPersonByEmail, loadPerson, personInput } from './people.js';
import { type LoadedQuestionnaire, loadQuestionnaire } from './questionnaires.js';
import { addRelation, appraiserList, confirmationView, loadRelation, removeRelation } from './relations.js';
import { policedSub } from '../../route-policy/index.js';
import { SURVEY360_LINK_POLICIES } from './policy.js';

export const LINK_TOKEN_HEADER = 'x-survey360-token';
const LINK_BASE = '/api/survey360/link';

const notFound = (): never => fail('NOT_FOUND', '链接无效或已失效');

async function linkTenant(c: C, deps: TenantRouteDeps): Promise<{ tenant: TenantContext; token: string }> {
  const tenantId = c.req.header('x-tenant-id');
  const token = c.req.header(LINK_TOKEN_HEADER);
  if (!tenantId || !isUuid(tenantId) || !token || token.length > 200) notFound();
  const tenant = await getTenant(deps.db, tenantId!);
  if (!tenant || tenant.status !== 'active') notFound();
  return { tenant: { tenantId: tenant!.id, userId: SYSTEM_USER_ID, timezone: tenant!.timezone }, token: token! };
}

/**
 * 作答入口：令牌链接，或登录账号本人的待办；caller 是命令台账的请求人；avatarBase 是本入口的头像地址前缀
 * （F-058 头像只经本入口、按本单具名人员取，待办入口没有令牌，不能指向令牌链接的地址）。
 */
export interface Entry {
  readonly tenant: TenantContext;
  readonly caller: TenantContext;
  readonly locate: (tx: Tx) => Promise<LinkRow | undefined>;
  readonly avatarBase: string;
}
export type EntryOf = (c: C) => Promise<Entry>;

function tokenEntry(deps: TenantRouteDeps): EntryOf {
  return async (c) => {
    const { tenant, token } = await linkTenant(c, deps);
    return { tenant, caller: tenant, locate: (tx) => findLink(tx, token), avatarBase: LINK_BASE };
  };
}

async function resolve(tx: Tx, locate: Entry['locate'], kind?: LinkRow['kind']) {
  const link = await locate(tx);
  if (!link || (kind !== undefined && link.kind !== kind)) notFound();
  const [activity] = rows<ActivityRow>(
    await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${link!.activityId}::uuid AND NOT deleted`),
  );
  if (!activity) notFound();
  // 确认链接：确认单已取消或评价对象已移除即失效，主页、候选人员与写入一律 404（第 1 轮审查 P2-3）
  if (link!.kind === 'confirm') {
    const [open] = rows<{ id: string }>(
      await tx.execute(sql`SELECT k.id FROM survey360_confirmations k
        JOIN survey360_objects o ON o.tenant_id = k.tenant_id AND o.id = k.object_id AND NOT o.removed
        WHERE k.id = ${link!.confirmationId}::uuid AND k.status <> 'cancelled'`),
    );
    if (!open) notFound();
  }
  // 作答链接：评价者在本活动已没有任何有效评价关系（最后一条被删，或最后一个对象被移除）时与无效链接一致，
  // 主页、本人头像、任务读写都不再返回活动信息（F-084，DEC-379④）
  if (link!.kind === 'answer' && !(await hasTask(tx, activity!.id, link!.personId))) notFound();
  return { link: link!, activity: activity! };
}

function linkRead<T>(
  deps: TenantRouteDeps,
  entryOf: EntryOf,
  kind: LinkRow['kind'] | undefined,
  load: (tx: Tx, link: LinkRow, a: ActivityRow, entry: Entry) => Promise<T>,
  respond: (c: C, body: T) => Response = (c, body) => c.json(body as object),
) {
  return async (c: C) => {
    const entry = await entryOf(c);
    const body = await withTenant(deps.db, entry.tenant.tenantId, async (tx) => {
      const { link, activity } = await resolve(tx, entry.locate, kind);
      return load(tx, link, activity, entry);
    });
    return respond(c, body);
  };
}

/** 链接写命令：命令前与命令事务内都重新解析链接并校验任务；指纹含链接，跨链接不会互相重放。 */
function linkWrite<T>(
  deps: TenantRouteDeps,
  entryOf: EntryOf,
  kind: LinkRow['kind'],
  schema: z.ZodType<T>,
  execute: (
    tx: Tx,
    ctx: Writer & { expectedRevision: number },
    link: LinkRow,
    a: ActivityRow,
    input: T,
  ) => Promise<unknown>,
  options: { status?: 200 | 201; guard?: (tx: Tx, link: LinkRow, a: ActivityRow) => Promise<unknown> } = {},
) {
  const status = options.status ?? 200;
  return async (c: C) => {
    const { tenant, caller, locate } = await entryOf(c);
    // 命令前（含幂等重放）先按当前状态校验链接与任务归属（第 1 轮审查 P2-4）
    const link = await withTenant(deps.db, tenant.tenantId, async (tx) => {
      const current = await resolve(tx, locate, kind);
      await options.guard?.(tx, current.link, current.activity);
      return current.link;
    });
    const expectedRevision = revision(c);
    const input = parse(schema, await jsonOrEmpty(c));
    const result = await runCommand(deps.db, caller, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, link: link.id, revision: expectedRevision, input },
      execute: async (tx, commandId) => {
        const current = await resolve(tx, locate, kind);
        const ctx = {
          tenantId: tenant.tenantId,
          userId: SYSTEM_USER_ID,
          commandId,
          now: deps.clock(),
          expectedRevision,
        };
        return { status, body: await execute(tx, ctx, current.link, current.activity, input) };
      },
    });
    return c.json(result.body as object, result.status);
  };
}

/** 作答页的评价角色显示（匿名开关）：角色名称 / 固定文字 / 不显示（键缺席）。 */
function roleLabel(activity: ActivityRow, role: { role_name: string; display_text: string | null }) {
  if (activity.role_display === 'hidden') return {};
  if (activity.role_display === 'fixed_text')
    return { role: { name: role.display_text ?? survey360.DEFAULT_ROLE_FIXED_TEXT } };
  return { role: { name: role.role_name } };
}

async function appraiserLabel(
  tx: Tx,
  activity: ActivityRow,
  personId: string,
  avatars: ReadonlyMap<string, AvatarReference | null>,
) {
  return activity.show_appraiser_name
    ? { appraiser: { name: (await loadPerson(tx, personId)).name, avatar: avatars.get(personId) ?? null } }
    : {};
}

/** 某评价关系需要作答的套卷：对象的套卷中包含该角色的。 */
async function sheetsOf(tx: Tx, task: TaskRow) {
  const ids = rows<{ questionnaire_id: string }>(
    await tx.execute(sql`SELECT oq.questionnaire_id FROM survey360_object_questionnaires oq
      JOIN survey360_questionnaire_roles qr ON qr.tenant_id = oq.tenant_id AND qr.questionnaire_id = oq.questionnaire_id
      WHERE oq.object_id = ${task.object_id}::uuid AND qr.role_id = ${task.role_id}::uuid ORDER BY oq.id`),
  ).map((r) => r.questionnaire_id);
  const result = [];
  for (const id of ids) {
    const q = await loadQuestionnaire(tx, id);
    const sheet = await findSheet(tx, task.id, id);
    result.push({ id, name: q.row.name, status: sheet?.status ?? 'pending' });
  }
  return result;
}

export async function answerPage(tx: Tx, link: LinkRow, activity: ActivityRow, avatarBase: string) {
  const tasks = rows<TaskRow>(
    await tx.execute(sql`${taskQuery(activity.id, link.personId)} ORDER BY o.sort, o.created_at, r.id`),
  );
  const avatars = await linkAvatars(tx, activity.tenant_id, answerPersonIds(link, activity, tasks), avatarBase);
  const items = [];
  for (const task of tasks)
    items.push({
      relationId: task.id,
      object: { name: task.object_name, avatar: avatars.get(task.object_person_id) ?? null },
      ...roleLabel(activity, task),
      questionnaires: await sheetsOf(tx, task),
    });
  return {
    kind: 'answer',
    activity: {
      id: activity.id,
      name: activity.name,
      welcome: activity.welcome,
      form: activity.form,
      status: activity.status,
    },
    ...(await appraiserLabel(tx, activity, link.personId, avatars)),
    tasks: items,
  };
}

function answerPersonIds(link: LinkRow, activity: ActivityRow, tasks: readonly TaskRow[]) {
  return [...tasks.map((task) => task.object_person_id), ...(activity.show_appraiser_name ? [link.personId] : [])];
}

/** 写入答卷前的任务归属校验（命令前与重放前同样执行）。 */
function taskGuard(relationId: string, questionnaireId: string) {
  return {
    guard: (tx: Tx, link: LinkRow, activity: ActivityRow) =>
      requireTask(tx, link, activity, relationId, questionnaireId),
  };
}

async function requireTask(
  tx: Tx,
  link: LinkRow,
  activity: ActivityRow,
  relationId: string,
  questionnaireId: string,
  lockObject = false,
) {
  const [task] = rows<TaskRow>(
    await tx.execute(sql`${taskQuery(activity.id, link.personId)} AND r.id = ${relationId}::uuid
      ${lockObject ? sql`FOR UPDATE OF o` : sql``}`),
  );
  if (!task) notFound();
  if (!(await sheetsOf(tx, task!)).some((q) => q.id === questionnaireId)) notFound();
  return { task: task!, questionnaire: await loadQuestionnaire(tx, questionnaireId) };
}

type SheetRow = typeof survey360Sheets.$inferSelect;

async function findSheet(tx: Tx, relationId: string, questionnaireId: string, lock = false) {
  const query = tx
    .select()
    .from(survey360Sheets)
    .where(and(eq(survey360Sheets.relationId, relationId), eq(survey360Sheets.questionnaireId, questionnaireId)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** 作答页的题目（关键行为）或基础指标（等级评定）：只给当前角色要评的条目，不给选项分值。 */
function itemsFor(q: LoadedQuestionnaire, roleId: string) {
  const allowed = new Set(survey360.answerableItems(q.model, roleId));
  const options = (scaleId: string | null) =>
    q.options
      .filter((o) => o.scaleId === scaleId)
      .map((o) => ({ id: o.id, label: o.label, remarkRequired: o.remarkRequired }));
  if (q.model.type === 'rating')
    return q.dimensions
      .filter((d) => allowed.has(d.id))
      .map((d) => ({ id: d.id, name: d.name, definition: d.definition, options: options(d.scaleId) }));
  return q.questions
    .filter((x) => allowed.has(x.id))
    .map((x) => ({
      id: x.id,
      text: x.text,
      dimension: q.dimensions.find((d) => d.id === x.dimensionId)?.name ?? null,
      allowRemark: x.allowRemark,
      options: options(x.scaleId),
    }));
}

const answersSchema = z.strictObject({
  answers: z
    .array(z.strictObject({ itemId: uuid, optionId: uuid, remark: z.string().trim().max(2000).optional() }))
    .max(2000),
  suggestion: z.string().trim().max(5000).nullable().optional(),
});

function scaleOfItem(q: LoadedQuestionnaire, itemId: string): string | null | undefined {
  if (q.model.type === 'rating') return q.dimensions.find((d) => d.id === itemId)?.scaleId;
  return q.questions.find((x) => x.id === itemId)?.scaleId;
}

function checkAnswers(q: LoadedQuestionnaire, roleId: string, answers: z.infer<typeof answersSchema>['answers']) {
  const allowed = new Set(survey360.answerableItems(q.model, roleId));
  if (new Set(answers.map((a) => a.itemId)).size !== answers.length)
    fail('VALIDATION_FAILED', '同一题目只能作答一次', 'DUPLICATE_ITEM');
  for (const a of answers) {
    if (!allowed.has(a.itemId)) fail('VALIDATION_FAILED', '题目不属于本次作答', 'ITEM_NOT_ALLOWED');
    const option = q.options.find((o) => o.id === a.optionId);
    if (!option || option.scaleId !== scaleOfItem(q, a.itemId))
      fail('VALIDATION_FAILED', '选项不属于该题目', 'OPTION_NOT_ALLOWED');
    // 备注：选项要求补充说明，或关键行为题目允许备注
    const question = q.questions.find((x) => x.id === a.itemId);
    if (a.remark && !option.remarkRequired && !question?.allowRemark)
      fail('VALIDATION_FAILED', '该题目不允许备注', 'REMARK_NOT_ALLOWED');
  }
}

/** 同一评价者在同一活动的作答串行化（优秀率按该评价者已提交的答卷计数）。 */
async function lockAppraiser(tx: Tx, tenantId: string, activityId: string, personId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:survey360-answer:${activityId}:${personId}`}, 0))`,
  );
}

const PAUSED = '活动暂停中，请稍后评价';

async function openSheet(tx: Tx, ctx: Writer, activity: ActivityRow, link: LinkRow, relationId: string, qid: string) {
  // 原站停用期间打开作答链接提示“活动暂停中，请稍后评价”（`25` §10.3 ③）
  if (activity.status !== 'enabled') fail('CONFLICT', PAUSED, 'ACTIVITY_NOT_OPEN');
  await lockAppraiser(tx, ctx.tenantId, activity.id, link.personId);
  // F-034 R2 / E3-R2：与替换共用活动 → 对象 → 答卷顺序；先锁活动避免新答卷外键形成反向等待。
  const [current] = rows<ActivityRow>(
    await tx.execute(sql`SELECT * FROM survey360_activities
      WHERE id = ${activity.id}::uuid AND NOT deleted FOR KEY SHARE`),
  );
  if (!current) notFound();
  if (current!.status !== 'enabled') fail('CONFLICT', PAUSED, 'ACTIVITY_NOT_OPEN');
  // 等锁期间可能已替换套卷，任务与套卷归属必须在取得对象锁后重新读取。
  const found = await requireTask(tx, link, current!, relationId, qid, true);
  const sheet = await findSheet(tx, relationId, qid, true);
  if (sheet?.status === 'submitted') fail('CONFLICT', '答卷已提交，不能再修改', 'SHEET_SUBMITTED');
  return { ...found, sheet };
}

async function auditSheet(
  tx: Tx,
  ctx: Writer,
  action: string,
  activity: ActivityRow,
  before: unknown,
  sheet: SheetRow,
) {
  // 活动 / 套卷元数据 before 与 after 对称：只在 after 里有的话，同一草稿再次保存会凭空多出“元数据新增”的差异，
  // 无资格查看人（答案 / 建议 / 评价关系已裁剪）还会被它撑出一条看似有变化的日志（F-060，#125 第 5 轮 P3-2）
  const meta = { activityId: activity.id, relationId: sheet.relationId, questionnaireId: sheet.questionnaireId };
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-sheet',
    objectId: sheet.id,
    before: before === null ? null : { ...meta, ...(before as object) },
    after: { ...meta, ...(await ownSheet(tx, sheet)) },
  });
}

async function excellenceCheck(
  tx: Tx,
  activity: ActivityRow,
  link: LinkRow,
  q: LoadedQuestionnaire,
  roleId: string,
  sheet: SheetRow,
): Promise<void> {
  const line = q.row.excellentLinePercent;
  const rate = q.row.excellentMaxRate;
  if (activity.form !== 'multiple' || line === null || rate === null) return;
  const model = q.model;
  const excellent = async (sheetId: string, role: string) =>
    survey360.isExcellent(await ownSheetTotal(tx, model, role, sheetId), survey360.maxTotal(model, role), Number(line));
  if (!(await excellent(sheet.id, roleId))) return;
  const roles = new Set(model.roles.map((r) => r.roleId));
  const relations = rows<{ id: string; role_id: string; sheet_id: string | null; status: string | null }>(
    await tx.execute(sql`SELECT r.id, r.role_id, s.id AS sheet_id, s.status FROM survey360_relations r
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      JOIN survey360_object_questionnaires oq ON oq.tenant_id = o.tenant_id AND oq.object_id = o.id
        AND oq.questionnaire_id = ${q.row.id}::uuid
      LEFT JOIN survey360_sheets s ON s.tenant_id = r.tenant_id AND s.relation_id = r.id
        AND s.questionnaire_id = ${q.row.id}::uuid
      WHERE r.activity_id = ${activity.id}::uuid AND r.appraiser_person_id = ${link.personId}::uuid AND NOT r.removed`),
  ).filter((r) => roles.has(r.role_id));
  let count = 1;
  for (const r of relations)
    if (r.sheet_id && r.sheet_id !== sheet.id && r.status === 'submitted' && (await excellent(r.sheet_id, r.role_id)))
      count += 1;
  if (count > survey360.excellentLimit(relations.length, Number(rate)))
    fail('VALIDATION_FAILED', '达到优秀线的人数已超过优秀率上限', 'EXCELLENT_RATE_EXCEEDED', {
      limit: survey360.excellentLimit(relations.length, Number(rate)),
    });
}

const task = '/tasks/:relationId/questionnaires/:questionnaireId';
const submitTask = `${task}/submit`;
const TODO = '/my/todos/:todoId';

/**
 * 作答页与答卷读写：令牌链接（/api/survey360/link）与站内待办（/api/tenant/survey360/my/todos/:todoId）两个入口
 * 共用同一套处理函数（answerRead / answerSave / answerSubmit / avatarRoute），按入口各注册一次；注册路径写成字面量，
 * F-039 静态扫描按注册处求值。
 */
export function registerAnswerRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps, entryOf: EntryOf) {
  module.get(task, answerRead(deps, entryOf));
  module.put(task, answerSave(deps, entryOf));
  module.post(submitTask, answerSubmit(deps, entryOf));
}

/** 站内待办“去处理”：登录账号本人作答，与链接作答同一套页面与命令（todos.ts todoEntry）。 */
export function registerTodoAnswerRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps, entryOf: EntryOf) {
  module.get(`${TODO}/answer`, (c) =>
    linkRead(deps, entryOf, 'answer', (tx, link, activity, entry) => answerPage(tx, link, activity, entry.avatarBase))(
      c,
    ),
  );
  module.get(`${TODO}/avatars/:attachmentId/content`, avatarRoute(deps, entryOf, 'answer'));
  module.get(`${TODO}${task}`, answerRead(deps, entryOf));
  module.put(`${TODO}${task}`, answerSave(deps, entryOf));
  module.post(`${TODO}${submitTask}`, answerSubmit(deps, entryOf));
}

function answerRead(deps: TenantRouteDeps, entryOf: EntryOf) {
  return async (c: C) =>
    linkRead(deps, entryOf, 'answer', async (tx, link, activity, entry) => {
      const { task: t, questionnaire } = await requireTask(
        tx,
        link,
        activity,
        uuidParam(c, 'relationId'),
        uuidParam(c, 'questionnaireId'),
      );
      const avatars = await linkAvatars(tx, activity.tenant_id, answerPersonIds(link, activity, [t]), entry.avatarBase);
      return {
        activity: { name: activity.name, form: activity.form, status: activity.status },
        object: { name: t.object_name, avatar: avatars.get(t.object_person_id) ?? null },
        ...(await appraiserLabel(tx, activity, link.personId, avatars)),
        ...roleLabel(activity, t),
        questionnaire: {
          id: questionnaire.row.id,
          name: questionnaire.row.name,
          type: questionnaire.row.type,
          guide: questionnaire.row.guide,
          items: itemsFor(questionnaire, t.role_id),
        },
        sheet: await ownSheet(tx, await findSheet(tx, t.id, questionnaire.row.id)),
      };
    })(c);
}

function answerSave(deps: TenantRouteDeps, entryOf: EntryOf) {
  return (c: C) => {
    const relationId = uuidParam(c, 'relationId');
    const qid = uuidParam(c, 'questionnaireId');
    return linkWrite(
      deps,
      entryOf,
      'answer',
      answersSchema,
      async (tx, ctx, link, activity, input) => {
        const { task: t, questionnaire, sheet } = await openSheet(tx, ctx, activity, link, relationId, qid);
        requireRevision(sheet?.revision ?? 0, ctx.expectedRevision);
        checkAnswers(questionnaire, t.role_id, input.answers);
        const before = sheet ? await ownSheet(tx, sheet) : null;
        let saved: SheetRow;
        if (sheet) {
          [saved] = (await tx
            .update(survey360Sheets)
            .set({
              revision: sheet.revision + 1,
              savedAt: ctx.now,
              ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
            })
            .where(eq(survey360Sheets.id, sheet.id))
            .returning()) as [SheetRow];
          await tx.delete(survey360Answers).where(eq(survey360Answers.sheetId, sheet.id));
        } else {
          [saved] = (await tx
            .insert(survey360Sheets)
            .values({
              tenantId: ctx.tenantId,
              activityId: activity.id,
              relationId,
              questionnaireId: qid,
              suggestion: input.suggestion ?? null,
              savedAt: ctx.now,
            })
            .returning()) as [SheetRow];
        }
        if (input.answers.length)
          await tx.insert(survey360Answers).values(
            input.answers.map((a) => ({
              tenantId: ctx.tenantId,
              sheetId: saved.id,
              itemId: a.itemId,
              optionId: a.optionId,
              remark: a.remark ?? null,
            })),
          );
        await auditSheet(tx, ctx, 'survey360.sheet.save', activity, before, saved);
        return ownSheet(tx, saved);
      },
      taskGuard(relationId, qid),
    )(c);
  };
}

function answerSubmit(deps: TenantRouteDeps, entryOf: EntryOf) {
  return (c: C) => {
    const relationId = uuidParam(c, 'relationId');
    const qid = uuidParam(c, 'questionnaireId');
    return linkWrite(
      deps,
      entryOf,
      'answer',
      z.object({}).passthrough(),
      async (tx, ctx, link, activity) => {
        const { task: t, questionnaire, sheet } = await openSheet(tx, ctx, activity, link, relationId, qid);
        if (!sheet) fail('VALIDATION_FAILED', '答卷未作答', 'INCOMPLETE');
        requireRevision(sheet!.revision, ctx.expectedRevision);
        const answers = await ownAnswers(tx, sheet!.id);
        const answered = new Map(answers.map((a) => [a.itemId, a]));
        const missing = survey360.answerableItems(questionnaire.model, t.role_id).filter((id) => !answered.has(id));
        if (missing.length) fail('VALIDATION_FAILED', '还有题目未作答', 'INCOMPLETE', { itemIds: missing });
        for (const a of answers) {
          const option = questionnaire.options.find((o) => o.id === a.optionId);
          if (option?.remarkRequired && !a.remark) fail('VALIDATION_FAILED', '所选选项须补充说明', 'REMARK_REQUIRED');
        }
        await excellenceCheck(tx, activity, link, questionnaire, t.role_id, sheet!);
        const [saved] = (await tx
          .update(survey360Sheets)
          .set({ status: 'submitted', submittedAt: ctx.now, revision: sheet!.revision + 1 })
          .where(eq(survey360Sheets.id, sheet!.id))
          .returning()) as [SheetRow];
        await auditSheet(tx, ctx, 'survey360.sheet.submit', activity, await ownSheet(tx, sheet), saved);
        await completeTodo(tx, ctx, activity.id, link.personId);
        return ownSheet(tx, saved);
      },
      taskGuard(relationId, qid),
    )(c);
  };
}

async function loadConfirmation(tx: Tx, link: LinkRow, lock = false) {
  const query = tx.select().from(survey360Confirmations).where(eq(survey360Confirmations.id, link.confirmationId!));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || row.status === 'cancelled') notFound();
  return row!;
}

async function confirmPage(tx: Tx, link: LinkRow, activity: ActivityRow) {
  const confirmation = await loadConfirmation(tx, link);
  const object = await tx.execute(sql`SELECT p.id, p.name FROM survey360_objects o JOIN survey360_people p
    ON p.tenant_id = o.tenant_id AND p.id = o.person_id WHERE o.id = ${confirmation.objectId}::uuid AND NOT o.removed`);
  const [target] = rows<{ id: string; name: string }>(object);
  if (!target) notFound();
  const list = await appraiserList(tx, confirmation.objectId);
  const avatars = await linkAvatars(tx, activity.tenant_id, [
    target!.id,
    ...list.items.map((row) => row.appraiserPersonId),
  ]);
  return {
    kind: 'confirm',
    activity: { name: activity.name, status: activity.status },
    object: { name: target!.name, avatar: avatars.get(target!.id) ?? null },
    status: confirmation.status,
    revision: confirmation.revision,
    appraisers: list.items.map((row) => ({
      ...row,
      appraiser: { ...row.appraiser, avatar: avatars.get(row.appraiserPersonId) ?? null },
    })),
    hint: list.hint,
  };
}

/** 确认人改评价关系：确认单待确认、活动未停用、revision 一致（AC-360-07：确认后前台不可改）。 */
async function openConfirmation(tx: Tx, ctx: { expectedRevision: number }, link: LinkRow, activity: ActivityRow) {
  const confirmation = await loadConfirmation(tx, link, true);
  if (confirmation.status !== 'pending')
    fail('CONFLICT', '评价关系已确认，不能再修改，如需调整请联系管理员', 'CONFIRMATION_CLOSED');
  if (activity.status === 'disabled') fail('CONFLICT', '活动已停用', 'ACTIVITY_DISABLED');
  requireRevision(confirmation.revision, ctx.expectedRevision);
  return confirmation;
}

async function bumpConfirmation(
  tx: Tx,
  ctx: Writer,
  before: typeof survey360Confirmations.$inferSelect,
  status?: string,
) {
  const [saved] = await tx
    .update(survey360Confirmations)
    .set({
      revision: before.revision + 1,
      ...(status ? { status, confirmedAt: ctx.now } : {}),
    })
    .where(eq(survey360Confirmations.id, before.id))
    .returning();
  await audit360(tx, actor(ctx), {
    action: status ? 'survey360.confirmation.confirm' : 'survey360.confirmation.change',
    objectType: 'survey360-confirmation',
    objectId: before.id,
    before: { ...confirmationView(before), activityId: before.activityId },
    after: { ...confirmationView(saved!), activityId: before.activityId },
  });
}

function registerConfirmRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const entryOf = tokenEntry(deps);
  module.get('/confirmation/candidates', (c) =>
    linkRead(deps, entryOf, 'confirm', async (tx) => {
      // 上级、同事、下级、其他只能从内部员工中选（E3-R19）：只列已挂接组织员工的人员
      const q = c.req.query('q')?.trim() ?? '';
      const items = rows<{ id: string; name: string; department: string | null; position: string | null }>(
        await tx.execute(sql`SELECT id, name, department, position FROM survey360_people
          WHERE employee_id IS NOT NULL AND name ILIKE ${`%${q}%`} ORDER BY name, id LIMIT 50`),
      );
      // 候选搜索跨本单人员，选择前只用默认头像，不能扩大确认令牌的实际图片下载名单。
      return { items: items.map((person) => ({ ...person, avatar: null })) };
    })(c),
  );
  module.post('/confirmation/appraisers', (c) =>
    linkWrite(
      deps,
      entryOf,
      'confirm',
      z.strictObject({ personId: uuid.optional(), person: personInput.optional(), roleId: uuid }),
      async (tx, ctx, link, activity, input) => {
        const confirmation = await openConfirmation(tx, ctx, link, activity);
        const role = rows<{ code: string | null }>(
          await tx.execute(sql`SELECT code FROM survey360_roles WHERE id = ${input.roleId}::uuid`),
        )[0];
        if (!role) fail('VALIDATION_FAILED', '评价角色不存在', 'ROLE_NOT_FOUND');
        const internalOnly = survey360.INTERNAL_ONLY_ROLES.includes(role!.code as survey360.BuiltinRoleCode);
        let person;
        if (input.personId) person = await loadPerson(tx, input.personId);
        else if (input.person && !internalOnly)
          person = (await findPersonByEmail(tx, input.person.email)) ?? (await createPerson(tx, ctx, input.person));
        else fail('VALIDATION_FAILED', '上级、同事、下级、其他只能从内部员工中选', 'INTERNAL_ONLY');
        if (internalOnly && !person!.employeeId)
          fail('VALIDATION_FAILED', '上级、同事、下级、其他只能从内部员工中选', 'INTERNAL_ONLY');
        const relation = await addRelation(tx, ctx, activity, confirmation.objectId, person!, input.roleId, 'confirm');
        await bumpConfirmation(tx, ctx, confirmation);
        return { id: relation.id, appraiserPersonId: relation.appraiserPersonId, roleId: relation.roleId };
      },
      { status: 201 },
    )(c),
  );
  module.delete('/confirmation/appraisers/:relationId', (c) => {
    const relationId = uuidParam(c, 'relationId');
    // 关系须属于确认单的评价对象：先于状态与 revision 校验；命令前（含重放）同样校验，已移除的关系照认归属
    const owned = async (tx: Tx, link: LinkRow, removed = false) =>
      loadRelation(tx, (await loadConfirmation(tx, link)).objectId, relationId, false, removed);
    return linkWrite(
      deps,
      entryOf,
      'confirm',
      z.object({}).passthrough(),
      async (tx, ctx, link, activity) => {
        await owned(tx, link);
        const confirmation = await openConfirmation(tx, ctx, link, activity);
        const relation = await loadRelation(tx, confirmation.objectId, relationId, true);
        await removeRelation(tx, ctx, relation);
        await bumpConfirmation(tx, ctx, confirmation);
        return { id: relationId, removed: true };
      },
      { guard: (tx, link) => owned(tx, link, true) },
    )(c);
  });
  module.post('/confirmation/submit', (c) =>
    linkWrite(deps, entryOf, 'confirm', z.object({}).passthrough(), async (tx, ctx, link, activity) => {
      const confirmation = await openConfirmation(tx, ctx, link, activity);
      await bumpConfirmation(tx, ctx, confirmation, 'confirmed');
      return confirmPage(tx, link, activity);
    })(c),
  );
}

/** 链接入口不经租户成员中间件（外部评价者没有账号）；租户与令牌在每个处理函数里校验。 */
export function registerLinkRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // F-039：链接子应用套登记表（SURVEY360_LINK_POLICIES），注册行不变、处理函数不变
  const module = policedSub(router, SURVEY360_LINK_POLICIES, () => new Hono<TenantEnv>());
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  module.get('/', (c) =>
    linkRead(deps, tokenEntry(deps), undefined, async (tx, link, activity, entry) =>
      link.kind === 'answer'
        ? await answerPage(tx, link, activity, entry.avatarBase)
        : await confirmPage(tx, link, activity),
    )(c),
  );
  // 头像：令牌链接下作答与确认两种链接都可取（本单具名人员）
  module.get('/avatars/:attachmentId/content', avatarRoute(deps, tokenEntry(deps), undefined));
  registerAnswerRoutes(module, deps, tokenEntry(deps));
  registerConfirmRoutes(module, deps);
  router.route(LINK_BASE, module);
}

/** 本入口作答页 / 确认页里具名人员的头像字节（F-058）；不在本单人员集合里的与不存在同一 404。 */
function avatarRoute(deps: TenantRouteDeps, entryOf: EntryOf, kind: LinkRow['kind'] | undefined) {
  return (c: C) =>
    linkRead(
      deps,
      entryOf,
      kind,
      async (tx, link, activity) => {
        const id = c.req.param('attachmentId') ?? '';
        if (!isUuid(id)) notFound();
        const allowed = await avatarPersonIds(tx, link, activity);
        const content = await linkAvatarContent(tx, activity.tenant_id, allowed, id.toLowerCase());
        return content ?? notFound();
      },
      (ctx, image) => {
        ctx.header('Cache-Control', 'private, no-store');
        ctx.header('Content-Disposition', 'inline');
        ctx.header('X-Content-Type-Options', 'nosniff');
        ctx.header('Content-Type', image.contentType);
        return ctx.body(new Uint8Array(image.bytes));
      },
    )(c);
}

/** 与作答任务 / 确认页相同的当前人员集合；匿名评价者不会成为单独的图片权限来源。 */
export async function avatarPersonIds(tx: Tx, link: LinkRow, activity: ActivityRow) {
  if (link.kind === 'answer') {
    const tasks = rows<TaskRow>(await tx.execute(taskQuery(activity.id, link.personId)));
    return answerPersonIds(link, activity, tasks);
  }
  const confirmation = await loadConfirmation(tx, link);
  const object = await requireObject(tx, activity.id, confirmation.objectId);
  const appraisers = await appraiserList(tx, object.id);
  return [object.person_id, ...appraisers.items.map((row) => row.appraiserPersonId)];
}
