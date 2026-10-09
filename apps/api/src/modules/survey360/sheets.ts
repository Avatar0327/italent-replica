/**
 * 数据筛选：原始数据与屏蔽无效数据（`25` §10.1 ⑥⑦⑧、§10.3；AC-360-08）：
 * - 原始数据只在活动停用后列出（启用中为空），每份已提交答卷一张卡片：套卷、角色、是否屏蔽、总分、逐题得分；
 *   评价者“保密”——卡片不带任何评价者标识（姓名、人员 ID、评价关系 ID），按角色与随机答卷 ID 排序，不按作答先后；
 * - 屏蔽粒度 = 评价者 × 套卷（一份答卷），可取消、可一键恢复；“屏蔽疑似无效数据”2 小时一次。首版判两条：放弃作答
 *   （选“不计分”选项）题量 > 50%；关键行为套卷所有题目选择同一选项。平均单题耗时未采集，不判（🟡）；
 * - 屏蔽不立即重算：被屏蔽的答卷在下一次停用计分时不参与（scoring.ts），作答数据变化使旧报告失效；
 * - 精细化权限下只含范围内评价对象、范围内评价者的答卷，范围外的与不存在同一 404。
 */
import { sql, survey360Answers, survey360Sheets, type Tx, eq } from '@italent/db';
import { survey360 } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { type ActivityRow, requireActivity } from './access.js';
import {
  actor,
  type Admin,
  asIs,
  audit360,
  fail,
  pick,
  read,
  requireRevision,
  rows,
  type Survey360Context,
  write,
} from './context.js';
import { personFilter } from './people.js';
import { type LoadedQuestionnaire, loadQuestionnaire } from './questionnaires.js';
import { markDataChanged } from './changes.js';

const SUSPECT_INTERVAL_MS = 2 * 60 * 60 * 1000;

interface SheetRow {
  id: string;
  object_id: string;
  object_name: string;
  questionnaire_id: string;
  role_id: string;
  role_name: string;
  blocked: boolean;
  blocked_source: string | null;
  revision: number;
}

/** 范围内、已提交的答卷（未移除的评价对象与评价关系）。 */
async function submittedSheets(tx: Tx, activityId: string, admin: Admin, sheetId?: string): Promise<SheetRow[]> {
  const objectFilter = personFilter(admin, sql`op`);
  const appraiserFilter = personFilter(admin, sql`ap`);
  return rows<SheetRow>(
    await tx.execute(sql`SELECT s.id, r.object_id, op.name AS object_name, s.questionnaire_id, r.role_id,
        ro.name AS role_name, s.blocked, s.blocked_source, s.revision
      FROM survey360_sheets s
      JOIN survey360_relations r ON r.tenant_id = s.tenant_id AND r.id = s.relation_id AND NOT r.removed
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      JOIN survey360_object_questionnaires oq ON oq.tenant_id = o.tenant_id AND oq.object_id = o.id
        AND oq.questionnaire_id = s.questionnaire_id
      JOIN survey360_people op ON op.tenant_id = o.tenant_id AND op.id = o.person_id
      JOIN survey360_people ap ON ap.tenant_id = r.tenant_id AND ap.id = r.appraiser_person_id
      JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id
      WHERE s.activity_id = ${activityId}::uuid AND s.status = 'submitted'
        ${sheetId ? sql`AND s.id = ${sheetId}::uuid` : sql``}
        ${objectFilter ? sql`AND ${objectFilter}` : sql``} ${appraiserFilter ? sql`AND ${appraiserFilter}` : sql``}
      ORDER BY o.sort, o.created_at, s.questionnaire_id, ro.sort, s.id`),
  );
}

async function answersOf(tx: Tx, sheetId: string) {
  return tx
    .select({ itemId: survey360Answers.itemId, optionId: survey360Answers.optionId })
    .from(survey360Answers)
    .where(eq(survey360Answers.sheetId, sheetId));
}

function card(sheet: SheetRow, q: LoadedQuestionnaire, answers: { itemId: string; optionId: string }[]) {
  const picked = new Map(answers.map((a) => [a.itemId, a.optionId]));
  const option = (id: string | undefined) => q.options.find((o) => o.id === id);
  return {
    id: sheet.id,
    objectId: sheet.object_id,
    objectName: sheet.object_name,
    questionnaireId: q.row.id,
    questionnaireName: q.row.name,
    role: { id: sheet.role_id, name: sheet.role_name },
    blocked: sheet.blocked,
    blockSource: sheet.blocked_source,
    total: survey360.scoreSheet(q.model, sheet.role_id, picked).total,
    items: survey360.answerableItems(q.model, sheet.role_id).map((itemId) => {
      const chosen = option(picked.get(itemId));
      return {
        itemId,
        optionLabel: chosen?.label ?? null,
        score: chosen && !chosen.notScored ? chosen.value : null,
      };
    }),
    revision: sheet.revision,
  };
}

async function cards(tx: Tx, sheets: readonly SheetRow[]) {
  const cache = new Map<string, LoadedQuestionnaire>();
  const result = [];
  for (const sheet of sheets) {
    let q = cache.get(sheet.questionnaire_id);
    if (!q) cache.set(sheet.questionnaire_id, (q = await loadQuestionnaire(tx, sheet.questionnaire_id)));
    result.push(card(sheet, q, await answersOf(tx, sheet.id)));
  }
  return result;
}

/** 疑似无效：放弃作答（不计分选项）题量过半；关键行为套卷所有题目选择同一选项（至少两题）。 */
function suspected(q: LoadedQuestionnaire, roleId: string, answers: { itemId: string; optionId: string }[]) {
  const items = survey360.answerableItems(q.model, roleId);
  const notScored = new Set(q.options.filter((o) => o.notScored).map((o) => o.id));
  const abandoned = answers.filter((a) => notScored.has(a.optionId)).length;
  if (items.length && abandoned / items.length > 0.5) return true;
  if (q.model.type !== 'key_behavior' || answers.length < 2) return false;
  return new Set(answers.map((a) => a.optionId)).size === 1;
}

function requireDisabled(activity: ActivityRow) {
  if (activity.status !== 'disabled') fail('CONFLICT', '活动停用后才能筛选数据', 'ACTIVITY_NOT_DISABLED');
}

async function setBlocked(tx: Tx, ctx: Survey360Context, activityId: string, sheet: SheetRow, source: string | null) {
  await tx
    .update(survey360Sheets)
    .set({
      blocked: source !== null,
      blockedSource: source,
      blockedAt: source ? ctx.now : null,
      blockedBy: source ? ctx.userId : null,
      revision: sheet.revision + 1,
    })
    .where(eq(survey360Sheets.id, sheet.id));
  await audit360(tx, actor(ctx), {
    action: source ? 'survey360.sheet.block' : 'survey360.sheet.unblock',
    objectType: 'survey360-sheet',
    objectId: sheet.id,
    before: { activityId, blocked: sheet.blocked, blockSource: sheet.blocked_source },
    after: { activityId, blocked: source !== null, blockSource: source },
  });
}

async function visibleSheet(tx: Tx, activityId: string, admin: Admin, sheetId: string) {
  const [sheet] = await submittedSheets(tx, activityId, admin, sheetId);
  if (!sheet) fail('NOT_FOUND', '答卷不存在');
  return sheet;
}

const BLOCK = { object: 'answer', operation: 'update', button: 'block' } as const;

export function registerSheetRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/sheets', (c) =>
    read(c, deps, { object: 'answer' }, async (tx, admin) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      // 启用中“数据筛选”列表为空（原站置灰）
      if (activity.status !== 'disabled') return { items: [] };
      return { items: await cards(tx, await submittedSheets(tx, activity.id, admin)) };
    }),
  );
  for (const action of ['block', 'unblock'] as const)
    module.post(`/activities/:id/sheets/:sheetId/${action}`, (c) => {
      const id = uuidParam(c);
      const sheetId = uuidParam(c, 'sheetId');
      return write(
        c,
        deps,
        z.object({}).passthrough(),
        async (tx, ctx) => {
          const activity = await requireActivity(tx, ctx.admin, id, true);
          const sheet = await visibleSheet(tx, activity.id, ctx.admin, sheetId);
          requireDisabled(activity);
          requireRevision(sheet.revision, ctx.expectedRevision);
          if (action === 'block' && sheet.blocked) fail('CONFLICT', '答卷已屏蔽', 'ALREADY_BLOCKED');
          if (action === 'unblock' && !sheet.blocked) fail('CONFLICT', '答卷未屏蔽', 'NOT_BLOCKED');
          await setBlocked(tx, ctx, activity.id, sheet, action === 'block' ? 'manual' : null);
          await markDataChanged(tx, activity.id, ctx.now, [sheet.object_id]);
          const [saved] = await cards(tx, [await visibleSheet(tx, activity.id, ctx.admin, sheetId)]);
          return saved;
        },
        {
          need: BLOCK,
          fields: 'none',
          guard: async (tx, admin) => {
            await visibleSheet(tx, (await requireActivity(tx, admin, id)).id, admin, sheetId);
          },
          // 单张卡片：卡片自带逐题得分 items，不是列表信封，按单个对象裁剪
          present: async (viewer, body: object) => pick(body, await viewer.fields('answer')),
        },
      );
    });
  registerBatchBlocking(module, deps);
}

function registerBatchBlocking(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const batch = (path: string, run: (tx: Tx, ctx: Survey360Context, activity: ActivityRow) => Promise<object>) =>
    module.post(`/activities/:id/sheets/${path}`, (c) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        z.object({}).passthrough(),
        async (tx, ctx) => {
          const activity = await requireActivity(tx, ctx.admin, id, true);
          requireDisabled(activity);
          return run(tx, ctx, activity);
        },
        {
          need: BLOCK,
          fields: 'none',
          revisionFree: true,
          guard: async (tx, admin) => void (await requireActivity(tx, admin, id)),
          // 回执只有人数（协议字段）
          present: asIs,
        },
      );
    });
  batch('block-suspected', async (tx, ctx, activity) => {
    const last = activity.suspect_blocked_at ? new Date(activity.suspect_blocked_at).getTime() : null;
    if (last !== null && ctx.now.getTime() - last < SUSPECT_INTERVAL_MS)
      fail('CONFLICT', '此功能2小时内仅允许使用一次', 'RATE_LIMITED');
    const changed: string[] = [];
    for (const sheet of await submittedSheets(tx, activity.id, ctx.admin)) {
      if (sheet.blocked) continue;
      const q = await loadQuestionnaire(tx, sheet.questionnaire_id);
      if (!suspected(q, sheet.role_id, await answersOf(tx, sheet.id))) continue;
      await setBlocked(tx, ctx, activity.id, sheet, 'suspected');
      changed.push(sheet.object_id);
    }
    await tx.execute(sql`UPDATE survey360_activities SET suspect_blocked_at = ${ctx.now.toISOString()}::timestamptz
      WHERE id = ${activity.id}::uuid`);
    if (changed.length) await markDataChanged(tx, activity.id, ctx.now, changed);
    return { blocked: changed.length };
  });
  batch('unblock-all', async (tx, ctx, activity) => {
    const changed: string[] = [];
    for (const sheet of await submittedSheets(tx, activity.id, ctx.admin)) {
      if (!sheet.blocked) continue;
      await setBlocked(tx, ctx, activity.id, sheet, null);
      changed.push(sheet.object_id);
    }
    if (changed.length) await markDataChanged(tx, activity.id, ctx.now, changed);
    return { unblocked: changed.length };
  });
}
