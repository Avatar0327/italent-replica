/**
 * 数据筛选：原始数据与屏蔽无效数据（`25` §10.1 ⑥⑦⑧、§10.3；AC-360-08）：
 * - 原始数据只在活动停用后列出（启用中为空），每份已提交答卷一张卡片：套卷、角色、是否屏蔽、总分、逐题得分；
 *   评价者“保密”——卡片不带任何评价者标识（姓名、人员 ID、评价关系 ID），按角色与随机答卷 ID 排序，不按作答先后；
 * - 屏蔽粒度 = 评价者 × 套卷（一份答卷），可取消、可一键恢复；“屏蔽疑似无效数据”2 小时一次。判三条：放弃作答
 *   （选“不计分”选项）题量 > 50%；关键行为套卷所有题目选择同一选项；平均单题耗时 < 1.5 秒（DEC-392：首次打开 → 提交，
 *   空闲计入，分母为全部可答题，按份判断；没有计时记录的历史答卷不判耗时）；
 * - 屏蔽不立即重算：被屏蔽的答卷在下一次停用计分时不参与（scoring.ts），作答数据变化使旧报告失效；
 * - 精细化权限下只含范围内评价对象、范围内评价者的答卷，范围外的与不存在同一 404。
 */
import { sql, survey360Sheets, type Tx, eq } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { type ActivityRow, requireActivity } from './access.js';
import { type CardSheet, isSuspected, requireCardViewer, sheetCards } from './anonymous.js';
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

type SheetRow = CardSheet;

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

/** 同一请求内套卷只装载一次（卡片按套卷算总分与逐题得分）。 */
function questionnaireCache(tx: Tx) {
  const cache = new Map<string, Promise<LoadedQuestionnaire>>();
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, loadQuestionnaire(tx, id));
    return cache.get(id)!;
  };
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
      // DEC-358②：逐份卡片只给“全部活动”持有人与活动创建者（兼任者除外），其他人只看各题汇总
      await requireCardViewer(tx, admin, activity);
      // 启用中“数据筛选”列表为空（原站置灰）
      if (activity.status !== 'disabled') return { items: [] };
      const found = await submittedSheets(tx, activity.id, admin);
      return { items: await sheetCards(tx, admin, activity, found, questionnaireCache(tx)) };
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
          await requireCardViewer(tx, ctx.admin, activity);
          const sheet = await visibleSheet(tx, activity.id, ctx.admin, sheetId);
          requireDisabled(activity);
          requireRevision(sheet.revision, ctx.expectedRevision);
          if (action === 'block' && sheet.blocked) fail('CONFLICT', '答卷已屏蔽', 'ALREADY_BLOCKED');
          if (action === 'unblock' && !sheet.blocked) fail('CONFLICT', '答卷未屏蔽', 'NOT_BLOCKED');
          await setBlocked(tx, ctx, activity.id, sheet, action === 'block' ? 'manual' : null);
          await markDataChanged(tx, activity.id, ctx.now, [sheet.object_id]);
          const current = await visibleSheet(tx, activity.id, ctx.admin, sheetId);
          const [saved] = await sheetCards(tx, ctx.admin, activity, [current], questionnaireCache(tx));
          return saved;
        },
        {
          need: BLOCK,
          fields: 'none',
          // 按编号屏蔽会返回单张卡片：与卡片列表同一查看人（DEC-358②）
          guard: async (tx, admin) => {
            const activity = await requireActivity(tx, admin, id);
            await requireCardViewer(tx, admin, activity);
            await visibleSheet(tx, activity.id, admin, sheetId);
          },
          // 单张卡片：卡片自带逐题得分 items，不是列表信封，按单个对象裁剪
          present: async (viewer, body: object) => pick(body, await viewer.fields('answer')),
        },
      );
    });
  registerBatchBlocking(module, deps);
}

type BatchRun = (tx: Tx, ctx: Survey360Context, activity: ActivityRow) => Promise<object>;

function registerBatchBlocking(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const RUNS: Readonly<Record<string, BatchRun>> = { 'block-suspected': blockSuspected, 'unblock-all': unblockAll };
  // 路径写成字面量数组：F-039 静态扫描按注册处求值
  for (const path of ['block-suspected', 'unblock-all']) {
    const run = RUNS[path]!;
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
  }
}

const blockSuspected: BatchRun = async (tx, ctx, activity) => {
  const last = activity.suspect_blocked_at ? new Date(activity.suspect_blocked_at).getTime() : null;
  if (last !== null && ctx.now.getTime() - last < SUSPECT_INTERVAL_MS)
    fail('CONFLICT', '此功能2小时内仅允许使用一次', 'RATE_LIMITED');
  const changed: string[] = [];
  for (const sheet of await submittedSheets(tx, activity.id, ctx.admin)) {
    if (sheet.blocked) continue;
    const q = await loadQuestionnaire(tx, sheet.questionnaire_id);
    if (!(await isSuspected(tx, q, sheet.role_id, sheet.id))) continue;
    await setBlocked(tx, ctx, activity.id, sheet, 'suspected');
    changed.push(sheet.object_id);
  }
  await tx.execute(sql`UPDATE survey360_activities SET suspect_blocked_at = ${ctx.now.toISOString()}::timestamptz
      WHERE id = ${activity.id}::uuid`);
  if (changed.length) await markDataChanged(tx, activity.id, ctx.now, changed);
  return { blocked: changed.length };
};

const unblockAll: BatchRun = async (tx, ctx, activity) => {
  const changed: string[] = [];
  for (const sheet of await submittedSheets(tx, activity.id, ctx.admin)) {
    if (!sheet.blocked) continue;
    await setBlocked(tx, ctx, activity.id, sheet, null);
    changed.push(sheet.object_id);
  }
  if (changed.length) await markDataChanged(tx, activity.id, ctx.now, changed);
  return { unblocked: changed.length };
};
