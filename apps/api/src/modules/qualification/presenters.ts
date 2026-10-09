/**
 * 专项响应的裁剪（DEC-309；第 2 轮 P2-02）：不走对象行的接口同样逐节点按查看人当前的字段权限与源对象的读取范围给出，
 * 看不到的不出现，不从原始数据重建。
 * - 指标等级描述：手改的按 TargetGradeDescription.description；未手改的是等级明细的投影，等级方案须在查看人读取
 *   范围内（字典：看全部 ∪ 创建人）且 GradeScheme.details 可见，否则描述、名称、等级都不给；
 * - 发展通道：按 DevelopmentChannel 的字段逐条；目标类别 / 级别另须在查看人读取范围内；纵向级别 ID 随标准的
 *   levelIds，顺序号随级别的 displayOrder 字段与该级别的读取范围；
 * - 图谱：只用裁剪后的标准拼装，级别 ID 随 levelIds、顺序号随级别字段权，明细、级别描述随标准字段权。
 */
import { sql, withTenant } from '@italent/db';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  accessSql,
  fieldVisible,
  objectFields,
  type QualificationContext,
  qualificationScope,
  rowsOf,
} from './access.js';
import type { StandardView } from './read-model.js';
import { presenter, readableIds } from './route-support.js';
import type { ChannelView } from './standard-service.js';
import type { GradeDescriptionView } from './target-service.js';

/** 等级方案对查看人可读（对象查看权 + 字典范围）且明细字段可见。 */
async function schemeDetailsVisible(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  schemeId: string | null,
): Promise<boolean> {
  if (!schemeId || !fieldVisible(await objectFields(deps, ctx, 'gradeScheme'), 'details')) return false;
  const scope = await qualificationScope(c, deps, ctx, 'gradeScheme');
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT 1 FROM ql_grade_schemes t WHERE t.tenant_id = ${ctx.tenantId}::uuid
      AND t.id = ${schemeId}::uuid AND ${accessSql(ctx, scope, 'dictionary').readable}`);
    return rowsOf(result).length > 0;
  });
}

export async function presentGradeDescriptions(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  schemeId: string | null,
  items: readonly GradeDescriptionView[],
) {
  const scheme = await schemeDetailsVisible(c, deps, ctx, schemeId);
  const own = fieldVisible(await objectFields(deps, ctx, 'targetGradeDescription'), 'description');
  return items.map((item) => ({
    gradeDetailId: item.gradeDetailId,
    modified: item.modified,
    ...(scheme ? { name: item.name, grade: item.grade } : {}),
    ...((item.modified ? own : scheme) ? { description: item.description } : {}),
  }));
}

export async function presentChannels(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  view: ChannelView,
) {
  const channel = await objectFields(deps, ctx, 'developmentChannel');
  const standard = await objectFields(deps, ctx, 'standard');
  const levelOrder = await levelOrderVisible(
    c,
    deps,
    ctx,
    view.vertical.map((node) => node.levelId),
  );
  const categories = await readableIds(
    c,
    deps,
    ctx,
    'category',
    view.horizontal.map((h) => h.targetCategoryId),
  );
  const levels = await readableIds(
    c,
    deps,
    ctx,
    'level',
    view.horizontal.map((h) => h.targetLevelId),
  );
  const show = (field: string) => fieldVisible(channel, field);
  return {
    standardId: view.standardId,
    revision: view.revision,
    vertical: fieldVisible(standard, 'levelIds')
      ? view.vertical.map((node) => ({
          levelId: node.levelId,
          ...(levelOrder.has(node.levelId) ? { displayOrder: node.displayOrder } : {}),
        }))
      : [],
    horizontal: view.horizontal.map((node) => ({
      ...(show('levelId') ? { levelId: node.levelId } : {}),
      ...(show('targetCategoryId') && categories.has(node.targetCategoryId)
        ? { targetCategoryId: node.targetCategoryId }
        : {}),
      ...(show('targetLevelId') && levels.has(node.targetLevelId) ? { targetLevelId: node.targetLevelId } : {}),
    })),
  };
}

/** 能给出顺序号的级别：查看人对级别的顺序号字段可见，且该级别在其读取范围内。 */
async function levelOrderVisible(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!fieldVisible(await objectFields(deps, ctx, 'level'), 'displayOrder')) return new Set();
  return readableIds(c, deps, ctx, 'level', ids);
}

/** 图谱：标准先按标准字段权限裁剪，再按级别拼装；级别 ID 只在 levelIds 可见时出现，顺序号按级别字段权。 */
export async function presentChart(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  standard: StandardView,
  orders: ReadonlyMap<string, number>,
) {
  const [shown] = (await presenter(deps, 'standard')(c, ctx, [standard])) as Partial<StandardView>[];
  if (!shown?.levelIds) return { standardId: standard.id, levels: [] };
  const visibleOrder = await levelOrderVisible(c, deps, ctx, shown.levelIds);
  // 都看得到顺序号才按顺序号排，否则保持标准自身的级别顺序（不借排序泄露看不到的顺序号）
  const levelIds = shown.levelIds.every((id) => visibleOrder.has(id))
    ? [...shown.levelIds].sort((a, b) => orders.get(a)! - orders.get(b)!)
    : [...shown.levelIds];
  return {
    standardId: standard.id,
    levels: levelIds.map((levelId) => ({
      levelId,
      ...(visibleOrder.has(levelId) ? { displayOrder: orders.get(levelId) } : {}),
      ...(shown.levelDescriptions
        ? { description: shown.levelDescriptions.find((d) => d.levelId === levelId)?.description }
        : {}),
      ...(shown.details ? { cells: shown.details.filter((detail) => detail.levelId === levelId) } : {}),
    })),
  };
}
