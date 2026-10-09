/**
 * 结果报表（`25` §7 实例、§10.1 ⑰、§10.3 ⑱⑲）：读活动最新计分批次（重算前仍是旧结果）。
 * - 关键行为类：总分 / 复合指标 / 基础指标 / 题目得分清单；等级评定类：总分 / 复合指标 / 基础指标；
 * - 列 = 自评、各角色（按角色顺序）、他评，保留 4 位小数；某列在整张清单里没有任何有效分数时整列消失，不加
 *   “已屏蔽 / 未作答”标记；单人角色照常单列（DEC-149）；
 * - 只有聚合分，没有评价者信息；精细化下只含范围内的评价对象。
 * “下载”是前端截取整块报表视图的 PNG（W-668），后端不提供 Excel 或其他数据导出。
 */
import { sql, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { requireActivity } from './access.js';
import { type Admin, fail, parse, type Present, read, rows, trimAliases, trimBody } from './context.js';
import {
  attachmentName,
  fileResponse,
  levelName,
  renderPng,
  type ScoreTablesBody,
  scoreTableDocument,
} from './export-files.js';
import { personFilter } from './people.js';

const query = z.strictObject({
  level: z.enum(['questionnaire', 'composite', 'basic', 'question']),
  type: z.enum(['key_behavior', 'rating']).default('key_behavior'),
});

interface ScoreRow {
  object_id: string;
  object_name: string;
  department: string | null;
  position: string | null;
  questionnaire_id: string;
  questionnaire_name: string;
  item_id: string | null;
  item_name: string | null;
  scope: 'self' | 'other' | 'role';
  role_id: string | null;
  role_name: string | null;
  role_sort: number | null;
  score: number | null;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** 清单级别 → 计分层级与条目过滤（复合指标 = 有下级的顶层指标，基础指标 = 叶子指标）。 */
function levelSql(level: z.infer<typeof query>['level']) {
  if (level === 'questionnaire') return sql`sc.level = 'questionnaire'`;
  if (level === 'question') return sql`sc.level = 'question'`;
  const hasChildren = sql`EXISTS (SELECT 1 FROM survey360_dimensions c WHERE c.tenant_id = d.tenant_id
    AND c.parent_id = d.id)`;
  return sql`sc.level = 'dimension' AND ${level === 'composite' ? hasChildren : sql`NOT ${hasChildren}`}`;
}

/** 逐行按结果对象字段裁剪；列头里的角色、口径与行里的分数值同样按字段权限去掉（第 2 轮 P2-4）。 */
const ALIASES = { roleId: 'roleId', roleName: 'roleName', scope: 'scope', values: 'score' } as const;
const present: Present = async (viewer, body: unknown) => {
  const fields = await viewer.fields('result');
  return trimAliases(fields, trimBody(fields, body), ALIASES);
};

/** 清单数据：JSON 接口与 PNG 下载共用同一份（下载由已按查看人裁剪的这份数据生成，F-060）。 */
async function scoreTables(tx: Tx, admin: Admin, id: string, raw: Record<string, string>) {
  const activity = await requireActivity(tx, admin, id);
  const input = parse(query, raw);
  if (input.type === 'rating' && input.level === 'question')
    fail('VALIDATION_FAILED', '等级评定套卷没有题目得分清单', 'LEVEL_NOT_AVAILABLE');
  if (!activity.score_batch_id)
    return { activityName: activity.name, body: { level: input.level, columns: [], items: [] } };
  const filter = personFilter(admin, sql`p`);
  const found = rows<ScoreRow>(
    await tx.execute(sql`SELECT o.id AS object_id, p.name AS object_name, p.department, p.position,
        q.id AS questionnaire_id, q.name AS questionnaire_name, sc.item_id,
        COALESCE(d.name, qu.text) AS item_name, sc.scope, sc.role_id, ro.name AS role_name, ro.sort AS role_sort,
        sc.score
      FROM survey360_scores sc
      JOIN survey360_objects o ON o.tenant_id = sc.tenant_id AND o.id = sc.object_id AND NOT o.removed
      JOIN survey360_people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id
      JOIN survey360_questionnaires q ON q.tenant_id = sc.tenant_id AND q.id = sc.questionnaire_id
      LEFT JOIN survey360_dimensions d ON d.tenant_id = sc.tenant_id AND d.id = sc.item_id
      LEFT JOIN survey360_questions qu ON qu.tenant_id = sc.tenant_id AND qu.id = sc.item_id
      LEFT JOIN survey360_roles ro ON ro.tenant_id = sc.tenant_id AND ro.id = sc.role_id
      WHERE sc.batch_id = ${activity.score_batch_id}::uuid AND q.type = ${input.type}
        AND ${levelSql(input.level)} ${filter ? sql`AND ${filter}` : sql``}
      ORDER BY o.sort, o.created_at, o.id, q.name, q.id, COALESCE(d.sort, qu.sort), sc.item_id`),
  );
  // 列：有有效分数的才出现（无有效数据的角色整列消失）
  const has = (scope: string, roleId: string | null) =>
    found.some((r) => r.scope === scope && r.role_id === roleId && r.score !== null);
  const roles = [
    ...new Map(
      found
        .filter((r) => r.scope === 'role' && r.role_id && has('role', r.role_id))
        .sort((a, b) => a.role_sort! - b.role_sort!)
        .map((r) => [r.role_id!, { scope: 'role' as const, roleId: r.role_id!, roleName: r.role_name! }]),
    ).values(),
  ];
  const columns = [
    ...(has('self', null) ? [{ scope: 'self' as const }] : []),
    ...roles,
    ...(has('other', null) ? [{ scope: 'other' as const }] : []),
  ];
  const items = new Map<string, ScoreRow[]>();
  for (const row of found) {
    const key = `${row.object_id}|${row.questionnaire_id}|${row.item_id ?? ''}`;
    items.set(key, [...(items.get(key) ?? []), row]);
  }
  const result = {
    level: input.level,
    columns,
    items: [...items.values()].map((group) => {
      const first = group[0]!;
      const value = (scope: string, roleId: string | null) => {
        const score = group.find((r) => r.scope === scope && r.role_id === roleId)?.score;
        return score === null || score === undefined ? null : round4(Number(score));
      };
      return {
        objectId: first.object_id,
        objectName: first.object_name,
        department: first.department,
        position: first.position,
        questionnaireId: first.questionnaire_id,
        questionnaireName: first.questionnaire_name,
        itemId: first.item_id,
        itemName: input.level === 'questionnaire' ? null : first.item_name,
        values: columns.map((col) => value(col.scope, 'roleId' in col ? col.roleId : null)),
      };
    }),
  };
  return { activityName: activity.name, body: result };
}

interface Loaded {
  readonly activityName: string;
  readonly body: ScoreTablesBody;
}
/** 下载：数据照常按查看人的结果字段裁剪，再交给渲染（活动名是活动可见者本就看得到的）。 */
const downloadPresent: Present = async (viewer, loaded: Loaded) => ({
  activityName: loaded.activityName,
  body: (await present(viewer, loaded.body as never)) as ScoreTablesBody,
});

export function registerTableRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/activities/:id/score-tables', (c) =>
    read(
      c,
      deps,
      { object: 'result' },
      async (tx, admin) => (await scoreTables(tx, admin, uuidParam(c), c.req.query())).body,
      present,
    ),
  );
  // 报表“下载”是整块报表视图的 PNG 截图（`25` §10.3 ⑱）：同一权限、同一范围与字段裁剪，只是换成图片
  module.get('/activities/:id/score-tables/download', (c) =>
    read(
      c,
      deps,
      { object: 'result' },
      (tx, admin) => scoreTables(tx, admin, uuidParam(c), c.req.query()),
      downloadPresent,
      async (_c, { activityName, body }: Loaded) => {
        const png = await renderPng(scoreTableDocument(body, { activityName }));
        return fileResponse(
          png,
          'image/png',
          attachmentName(`360度评估结果-${activityName}-${levelName(body.level)}`, 'png'),
        );
      },
    ),
  );
}
