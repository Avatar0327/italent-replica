/**
 * 发展通道查看——管理入口（C1-6，AC-QL-08；规格 23 §6 QL-R13、§15；设计 §5.2 #2、§5.3）：
 * - GET /api/tenant/qualification/employees/:employeeId/development-channel：员工的当前级别 + 纵向 + 横向；
 * - GET …/development-channel/levels/:levelId：点级别看标准（默认当前类别的标准；?categoryId 看横向目的地类别的标准）。
 * 授权（两道，缺一不可）：① 员工任职资格子集（TenantBase.Qualification）的查看权，且员工在查看人的人员范围内（范围外与不存在
 * 同为 404）——当前资格来自子集；② Qualification 的 DevelopmentChannel（卡片）/ QualificationStandard（点级别）对象查看权。
 * 类别 / 级别 / 标准 / 通道只放开查看（DEC-352），不再按管理单元裁剪；内容按查看人当前的字段权与源对象的读取权裁剪
 * （presentChannels / presentChart，与 /standards/:id/channels、/chart 同一口径，通用指标覆盖内容按 §5.2 #2 省略）。
 * 查看人看不到子集的 categoryId / levelId 字段时按空态给出，不从隐藏字段推导通道。
 * ESS 本人入口（员工通道卡片）在 employee-self-service/development-channel.ts，是另一条关系入口、固定投影。
 */
import { sql, withTenant } from '@italent/db';
import { SUBSETS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { access, preflight } from '../personnel/access.js';
import { uuidParam, uuidQuery } from '../talent/http.js';
import { qualificationContext, rowsOf } from './access.js';
import { currentQualification } from './current.js';
import { type ChannelOverview, channelOverview, standardOfCategory } from './development-channel-data.js';
import { presentChannels, presentChart } from './presenters.js';
import * as read from './read-model.js';
import { QL_BASE } from './route-support.js';

const SUBSET = SUBSETS.qualification.objectCode;

/** 员工任职资格子集的查看权 + 员工在查看人人员范围内；返回查看人能否看到当前类别 / 级别字段。 */
async function viewEmployeeQualification(c: Context<TenantEnv>, deps: TenantRouteDeps, employeeId: string) {
  const pctx = await access(c, deps, SUBSET, 'view');
  await preflight(deps, pctx, employeeId);
  const fields = await getModuleViewableFields(deps, pctx, SUBSET);
  const see = (field: string) => fields === undefined || fields.has(field);
  return { pctx, refsVisible: see('categoryId') && see('levelId'), see };
}

export function registerDevelopmentChannel(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const base = `${QL_BASE}/employees/:employeeId/development-channel`;

  router.get(base, async (c) => {
    const ctx = await qualificationContext(c, deps, 'developmentChannel');
    const employeeId = uuidParam(c, 'employeeId');
    const { refsVisible, see } = await viewEmployeeQualification(c, deps, employeeId);
    const tenant = tenantOf(c);
    const asOf = tenantLocalDate(deps.clock(), tenant.timezone);
    const overview: ChannelOverview = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      refsVisible ? channelOverview(tx, ctx.tenantId, employeeId, asOf) : { current: null, channel: null },
    );
    const { current, channel } = overview;
    const shown = channel ? await presentChannels(c, deps, ctx, channel) : null;
    return c.json({
      employeeId,
      asOf,
      current: current
        ? {
            categoryId: current.categoryId,
            levelId: current.levelId,
            ...(see('startDate') ? { startDate: current.startDate } : {}),
          }
        : null,
      standardId: shown?.standardId ?? null,
      vertical: shown?.vertical ?? [],
      horizontal: shown?.horizontal ?? [],
    });
  });

  router.get(`${base}/levels/:levelId`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'standard');
    const employeeId = uuidParam(c, 'employeeId');
    const levelId = uuidParam(c, 'levelId');
    const categoryQuery = uuidQuery(c, 'categoryId');
    const { refsVisible } = await viewEmployeeQualification(c, deps, employeeId);
    const tenant = tenantOf(c);
    const asOf = tenantLocalDate(deps.clock(), tenant.timezone);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const categoryId =
        categoryQuery ??
        (refsVisible ? (await currentQualification(tx, ctx.tenantId, employeeId, asOf))?.categoryId : undefined);
      const standardId = categoryId ? await standardOfCategory(tx, ctx.tenantId, categoryId) : null;
      if (!standardId) return null;
      const [standard] = await read.withStandardParts(tx, ctx.tenantId, [
        (await read.loadRow(tx, ctx.tenantId, 'standard', standardId))!,
      ]);
      const levels = rowsOf<{ id: string; display_order: number }>(
        await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${ctx.tenantId}::uuid
          AND id = ANY(${`{${standard!.levelIds.join(',')}}`}::uuid[])`),
      );
      return { standard: standard!, orders: new Map(levels.map((level) => [level.id, level.display_order])) };
    });
    const chart = found ? await presentChart(c, deps, ctx, found.standard, found.orders) : null;
    const level = chart?.levels.find((node) => node.levelId === levelId);
    if (!chart || !level) throw new AppError('NOT_FOUND', '该级别没有可查看的标准');
    return c.json({ standardId: chart.standardId, level });
  });
}
