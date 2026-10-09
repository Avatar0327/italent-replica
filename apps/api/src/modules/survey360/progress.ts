/**
 * 进程控制与重新作答（`25` §10.1、§10.3 ⑨⑩⑪⑫）：
 * - 评价者列表：状态、最后发送时间（邮件与待办都计入）、进度（已完成对象 / 全部对象）、邮件与待办状态；
 *   总进度 = 已完成评价者 / 全部评价者；被屏蔽的答卷仍算已完成（原站口径，与个人报告的评价关系表不同）；
 * - 进度明细：每个评价对象一行，状态 未开始 / 进行中 / 已评价 / 已评价(被屏蔽)，只列权限范围内的评价对象；
 * - 重新作答：只对已评价（含被屏蔽）的行；启用中、停用后都可；清除答卷与答案（审计留快照），不重发待办 / 邮件、
 *   不改最后发送时间；活动作答数据变化，旧报告失效（changes.ts markDataChanged）。
 * 精细化权限生效时，评价对象与评价者都要在范围内（与人员列表同一谓词），进度与总进度只按范围内的计。
 */
import { sql, survey360Answers, survey360Relations, survey360Sheets, type Tx, eq, inArray } from '@italent/db';
import type { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { iso, requireActivity } from './access.js';
import {
  actor,
  type Admin,
  audit360,
  fail,
  pick,
  type Present,
  read,
  requireRevision,
  rows,
  trimAs,
  write,
} from './context.js';
import { personFilter } from './people.js';
import { markDataChanged } from './changes.js';

export type RelationStatus = 'not_started' | 'in_progress' | 'submitted' | 'submitted_blocked';

export interface RelationState {
  readonly relationId: string;
  readonly objectId: string;
  readonly objectName: string;
  readonly appraiserPersonId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly revision: number;
  readonly status: RelationStatus;
}

interface StateRow {
  id: string;
  object_id: string;
  object_name: string;
  appraiser_person_id: string;
  role_id: string;
  role_name: string;
  revision: number;
  required: number;
  submitted: number;
  started: number;
  blocked: boolean;
}

function statusOf(row: StateRow): RelationStatus {
  if (row.required > 0 && row.submitted === row.required) return row.blocked ? 'submitted_blocked' : 'submitted';
  return row.started > 0 ? 'in_progress' : 'not_started';
}

export const isDone = (status: RelationStatus) => status === 'submitted' || status === 'submitted_blocked';

/**
 * 活动内未移除的评价关系及其作答状态：要答的套卷 = 对象的套卷中包含该角色的。admin 为空时不按范围过滤（待办完成
 * 判定等系统内部口径）；否则评价对象与评价者都须在查看人范围内。
 */
export async function relationStates(
  tx: Tx,
  activityId: string,
  admin: Admin | null,
  only: Only = {},
): Promise<RelationState[]> {
  if (!admin) return allRelationStates(tx, activityId, only);
  return statesOf(tx, activityId, only, [personFilter(admin, sql`op`), personFilter(admin, sql`ap`)]);
}

type Only = { readonly appraiserId?: string; readonly relationId?: string };

/** 系统内部口径（待办完成判定）：不按查看人范围过滤，与查看人无关。 */
export function allRelationStates(tx: Tx, activityId: string, only: Only = {}): Promise<RelationState[]> {
  return statesOf(tx, activityId, only, []);
}

async function statesOf(
  tx: Tx,
  activityId: string,
  only: Only,
  filters: readonly (SQL | null)[],
): Promise<RelationState[]> {
  const found = rows<StateRow>(
    await tx.execute(sql`SELECT r.id, r.object_id, op.name AS object_name, r.appraiser_person_id, r.role_id,
        ro.name AS role_name, r.revision,
        count(oq.questionnaire_id)::int AS required,
        (count(s.id) FILTER (WHERE s.status = 'submitted'))::int AS submitted,
        count(s.id)::int AS started,
        COALESCE(bool_or(s.blocked), false) AS blocked
      FROM survey360_relations r
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      JOIN survey360_people op ON op.tenant_id = o.tenant_id AND op.id = o.person_id
      JOIN survey360_people ap ON ap.tenant_id = r.tenant_id AND ap.id = r.appraiser_person_id
      JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id
      LEFT JOIN survey360_object_questionnaires oq ON oq.tenant_id = o.tenant_id AND oq.object_id = o.id
        AND EXISTS (SELECT 1 FROM survey360_questionnaire_roles qr WHERE qr.tenant_id = oq.tenant_id
          AND qr.questionnaire_id = oq.questionnaire_id AND qr.role_id = r.role_id)
      LEFT JOIN survey360_sheets s ON s.tenant_id = r.tenant_id AND s.relation_id = r.id
        AND s.questionnaire_id = oq.questionnaire_id
      WHERE r.activity_id = ${activityId}::uuid AND NOT r.removed
        ${only.appraiserId ? sql`AND r.appraiser_person_id = ${only.appraiserId}::uuid` : sql``}
        ${only.relationId ? sql`AND r.id = ${only.relationId}::uuid` : sql``}
        ${sql.join(
          filters.flatMap((f) => (f ? [sql`AND ${f}`] : [])),
          sql` `,
        )}
      GROUP BY r.id, op.name, ro.name, ro.sort, o.sort, o.created_at
      ORDER BY o.sort, o.created_at, ro.sort, r.id`),
  );
  return found.map((row) => ({
    relationId: row.id,
    objectId: row.object_id,
    objectName: row.object_name,
    appraiserPersonId: row.appraiser_person_id,
    roleId: row.role_id,
    roleName: row.role_name,
    revision: row.revision,
    status: statusOf(row),
  }));
}

export interface AppraiserProgress {
  readonly personId: string;
  readonly done: number;
  readonly total: number;
  readonly started: boolean;
}

/** 按评价者汇总：已完成对象数 / 全部对象数（被屏蔽算已完成）。 */
export function byAppraiser(states: readonly RelationState[]): Map<string, AppraiserProgress> {
  const result = new Map<string, AppraiserProgress>();
  for (const state of states) {
    const current = result.get(state.appraiserPersonId) ?? {
      personId: state.appraiserPersonId,
      done: 0,
      total: 0,
      started: false,
    };
    result.set(state.appraiserPersonId, {
      ...current,
      done: current.done + (isDone(state.status) ? 1 : 0),
      total: current.total + 1,
      started: current.started || state.status !== 'not_started',
    });
  }
  return result;
}

export const isComplete = (p: AppraiserProgress) => p.total > 0 && p.done === p.total;

function appraiserStatus(p: AppraiserProgress) {
  if (isComplete(p)) return 'completed';
  return p.started || p.done > 0 ? 'in_progress' : 'not_started';
}

interface AppraiserRow {
  id: string;
  name: string;
  email: string;
  last_sent_at: Date | string | null;
  email_state: string | null;
  todo: string | null;
  todo_reason: string | null;
}

/**
 * 查看人看到的待办状态（第 2 轮 P2-3）：受限管理员按范围内的完成情况给出“已处理 / 待处理”，不随范围外任务的完成而
 * 变化；取消过的一律“已处理”。不受限的管理员看真实状态。
 */
export function todoView(
  admin: Admin,
  todo: { status: string | null; reason: string | null },
  progress: AppraiserProgress,
): 'open' | 'done' | null {
  if (!todo.status) return null;
  if (!admin.people || todo.reason === 'cancelled') return todo.status as 'open' | 'done';
  return isComplete(progress) ? 'done' : 'open';
}

async function progressView(tx: Tx, activityId: string, admin: Admin) {
  const progress = byAppraiser(await relationStates(tx, activityId, admin));
  const ids = [...progress.keys()];
  const people = ids.length
    ? rows<AppraiserRow>(
        await tx.execute(sql`SELECT p.id, p.name, p.email,
          (SELECT l.last_sent_at FROM survey360_links l WHERE l.tenant_id = p.tenant_id
            AND l.activity_id = ${activityId}::uuid AND l.person_id = p.id AND l.kind = 'answer' AND NOT l.revoked
            LIMIT 1) AS last_sent_at,
          (SELECT x.state FROM survey360_outbox x WHERE x.tenant_id = p.tenant_id AND x.object_id = p.id
            AND x.event_type = 'survey360.answer_invitation' AND x.payload->>'activityId' = ${activityId}
            ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS email_state,
          (SELECT t.status FROM survey360_todos t WHERE t.tenant_id = p.tenant_id
            AND t.activity_id = ${activityId}::uuid AND t.person_id = p.id) AS todo,
          (SELECT t.done_reason FROM survey360_todos t WHERE t.tenant_id = p.tenant_id
            AND t.activity_id = ${activityId}::uuid AND t.person_id = p.id) AS todo_reason
          FROM survey360_people p WHERE p.id = ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY p.name, p.id`),
      )
    : [];
  const items = people.map((p) => {
    const item = progress.get(p.id)!;
    return {
      personId: p.id,
      name: p.name,
      email: p.email,
      status: appraiserStatus(item),
      lastSentAt: iso(p.last_sent_at),
      progress: { done: item.done, total: item.total },
      emailState: p.email_state,
      todo: todoView(admin, { status: p.todo, reason: p.todo_reason }, item),
    };
  });
  return { total: { completed: items.filter((i) => i.status === 'completed').length, all: items.length }, items };
}

function detailItem(state: RelationState) {
  return {
    relationId: state.relationId,
    objectId: state.objectId,
    objectName: state.objectName,
    roleId: state.roleId,
    roleName: state.roleName,
    status: state.status,
    revision: state.revision,
  };
}

/** 查看人范围内的某条评价关系；看不到与不存在同一 404。 */
async function visibleRelation(tx: Tx, activityId: string, admin: Admin, relationId: string) {
  const [state] = await relationStates(tx, activityId, admin, { relationId });
  if (!state) fail('NOT_FOUND', '评价关系不存在');
  return state;
}

const VIEW = { object: 'relation' } as const;

/** 进度明细：items 逐行、appraiser 信封都按评价关系对象的查看字段裁剪（第 2 轮 P2-2）。 */
const detailPresent: Present = async (viewer, body: { appraiser: object; items: object[] }) => {
  const fields = await viewer.fields('relation');
  return { appraiser: pick(body.appraiser, fields), items: body.items.map((row) => pick(row, fields)) };
};

async function progressDetail(tx: Tx, activityId: string, admin: Admin, personId: string) {
  const states = await relationStates(tx, activityId, admin, { appraiserId: personId });
  if (!states.length) fail('NOT_FOUND', '评价者不存在');
  const [person] = rows<{ name: string }>(
    await tx.execute(sql`SELECT name FROM survey360_people WHERE id = ${personId}::uuid`),
  );
  return { appraiser: { personId, name: person!.name }, items: states.map(detailItem) };
}

export function registerProgressRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/progress', (c) =>
    read(c, deps, VIEW, async (tx, admin) =>
      progressView(tx, (await requireActivity(tx, admin, uuidParam(c))).id, admin),
    ),
  );
  module.get('/activities/:id/progress/:personId', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin) =>
        progressDetail(tx, (await requireActivity(tx, admin, uuidParam(c))).id, admin, uuidParam(c, 'personId')),
      detailPresent,
    ),
  );
  module.post('/activities/:id/relations/:relationId/reanswer', (c) => {
    const id = uuidParam(c);
    const relationId = uuidParam(c, 'relationId');
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        const activity = await requireActivity(tx, ctx.admin, id, true);
        await visibleRelation(tx, activity.id, ctx.admin, relationId);
        const [locked] = await tx
          .select()
          .from(survey360Relations)
          .where(eq(survey360Relations.id, relationId))
          .for('update');
        requireRevision(locked!.revision, ctx.expectedRevision);
        const state = await visibleRelation(tx, activity.id, ctx.admin, relationId);
        if (!isDone(state.status)) fail('CONFLICT', '只有已评价的评价关系可以重新作答', 'NOT_SUBMITTED');
        const sheets = await tx.select().from(survey360Sheets).where(eq(survey360Sheets.relationId, relationId));
        for (const sheet of sheets) {
          const answers = await tx.select().from(survey360Answers).where(eq(survey360Answers.sheetId, sheet.id));
          await audit360(tx, actor(ctx), {
            action: 'survey360.sheet.clear',
            objectType: 'survey360-sheet',
            objectId: sheet.id,
            before: {
              activityId: activity.id,
              relationId,
              questionnaireId: sheet.questionnaireId,
              status: sheet.status,
              answers: answers.map((a) => ({ itemId: a.itemId, optionId: a.optionId, remark: a.remark })),
              suggestion: sheet.suggestion,
            },
            after: { activityId: activity.id, relationId, questionnaireId: sheet.questionnaireId, status: 'cleared' },
          });
        }
        const sheetIds = sheets.map((s) => s.id);
        if (sheetIds.length) {
          await tx.delete(survey360Answers).where(inArray(survey360Answers.sheetId, sheetIds));
          await tx.delete(survey360Sheets).where(inArray(survey360Sheets.id, sheetIds));
        }
        await tx
          .update(survey360Relations)
          .set({ revision: locked!.revision + 1 })
          .where(eq(survey360Relations.id, relationId));
        await markDataChanged(tx, activity.id, ctx.now, [state.objectId]);
        return detailItem(await visibleRelation(tx, activity.id, ctx.admin, relationId));
      },
      {
        need: { object: 'answer', operation: 'update', button: 'reanswer' },
        fields: 'none',
        guard: async (tx, admin) => {
          await visibleRelation(tx, (await requireActivity(tx, admin, id)).id, admin, relationId);
        },
        present: trimAs('relation'),
      },
    );
  });
}
