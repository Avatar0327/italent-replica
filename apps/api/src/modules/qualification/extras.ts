/**
 * 任职资格的专项接口（不是对象行的增删改查；路由声明见 docs/08_设计/R3-T02-A_任职资格配置_路由声明.md）：
 * 引入类别 / 级别、指标等级描述、编码规则、标准明细导入、发展通道、图谱。每个写入口登记“结果锚点”：首次与幂等
 * 重放都按当前范围复核（撤权后 404），响应按当前字段权限与源对象范围裁剪（第 2 轮 P2-01 / P2-02）。
 * 引入与导入在失败时另在独立事务里登记任务级日志（DEC-199，P2-12）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { QUALIFICATION_APP, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { rawImportRows, rawUuid, withFailedImportLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import type { ScopedJobKind } from '../permission/module-contracts.js';
import { type ModuleScope, resolveModuleScope, scopeSql } from '../permission/module-access.js';
import { authorizedUnits } from '../permission/owner-units.js';
import { parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  accessSql,
  checkWriteFields,
  codeOf,
  type QualificationObject,
  qualificationContext,
  qualificationScope,
  qualificationWriteContext,
  requireReadable,
  rowsOf,
  trimQualification,
} from './access.js';
import * as config from './config-service.js';
import * as input from './input.js';
import { presentChannels, presentChart, presentGradeDescriptions, presentWarnings } from './presenters.js';
import * as read from './read-model.js';
import { presenter, QL_BASE, requireAllVisible, runWrite, writeContext } from './route-support.js';
import * as standards from './standard-service.js';
import { rowAccess, type WriteContext } from './store.js';
import * as targets from './target-service.js';

const CATEGORY_JOBS: readonly ScopedJobKind[] = ['positions', 'posts', 'sequences', 'level-types'];
const LEVEL_JOBS: readonly ScopedJobKind[] = ['levels', 'grades'];

export function registerExtras(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerImports(router, deps);
  registerGradeDescriptions(router, deps);
  registerCodingRules(router, deps);
  registerStandardImport(router, deps);
  registerChannels(router, deps);
  registerChart(router, deps);
}

/**
 * 导入 / 引入失败时的任务级日志（DEC-199）：只取行数与可识别的归属编号，不存其他输入值。归属按实际操作的管理单元
 * / 目标锚点登记（第 3 轮 R2-07），让操作人与该单元的审计员经授权查询找得到：
 * - 引入类别 / 级别：请求选定的授权管理单元，没选时取唯一的授权管理单元（与新建时自动填同一口径，DEC-339）；
 * - 标准导入：行里类别的所属组织与其标准（标准锚在类别上），只认操作人当前写范围内的类别；范围外与找不到的一样
 *   退回唯一的授权管理单元——日志查不查得到不能成为范围外类别是否存在的探针。
 */
function importTask(c: Context<TenantEnv>, deps: TenantRouteDeps, object: QualificationObject, key: 'items' | 'rows') {
  return c.req
    .json()
    .catch(() => undefined)
    .then(async (raw: Record<string, unknown> | undefined) => {
      const rows = rawImportRows(raw, key);
      const tenant = tenantOf(c);
      // 标准的写范围即类别的（设计 §5.1）；在日志事务之外先解析
      const scope =
        object === 'standard' ? await resolveModuleScope(deps, tenant, undefined, codeOf('category')) : undefined;
      const requested = rawUuid(raw?.ownerOrgId);
      const categoryCodes = rows.map((row) => (typeof row.categoryCode === 'string' ? row.categoryCode : ''));
      return {
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        commandId: c.req.header('idempotency-key'),
        objectType: codeOf(object),
        total: rows.length,
        resolveAnchors: async (tx: Tx) => {
          const unit = await operatingUnit(tx, deps, tenant, requested);
          if (object !== 'standard') return rows.map(() => ({ objectId: null, orgId: unit }));
          const anchors = await categoryAnchors(tx, tenant.tenantId, categoryCodes, scope!);
          return categoryCodes.map((code) => anchors.get(code) ?? { objectId: null, orgId: unit });
        },
      };
    });
}

async function operatingUnit(
  tx: Tx,
  deps: TenantRouteDeps,
  tenant: { tenantId: string; userId: string; timezone: string },
  requested: string | null,
): Promise<string | null> {
  const asOf = tenantLocalDate(deps.clock(), tenant.timezone);
  const units = await authorizedUnits(tx, tenant.tenantId, tenant.userId, QUALIFICATION_APP, asOf);
  if (requested && units.some((unit) => unit.id === requested)) return requested;
  return units.length === 1 ? units[0]!.id : null;
}

async function categoryAnchors(tx: Tx, tenantId: string, codes: readonly string[], scope: ModuleScope) {
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length) return new Map<string, { objectId: string | null; orgId: string }>();
  const rows = rowsOf<{ code: string; owner_org_id: string; standard_id: string | null }>(
    await tx.execute(sql`SELECT c.code, c.owner_org_id, s.id AS standard_id FROM ql_categories c
      LEFT JOIN ql_standards s ON s.tenant_id = c.tenant_id AND s.category_id = c.id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND ${scopeSql(scope, { org: sql`c.owner_org_id`, creator: sql`c.owner_id` })} AND c.code IN (${sql.join(
          wanted.map((code) => sql`${code}`),
          sql`, `,
        )})`),
  );
  return new Map(rows.map((row) => [row.code, { objectId: row.standard_id, orgId: row.owner_org_id }]));
}

function registerImports(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 引入任职类别 / 级别（QL-R1 / R2，AC-QL-01）：新建授权 + 按钮；编码、名称、关联字段须有编辑权
  const importRoute = <T extends { items: unknown[] }>(
    object: 'category' | 'level',
    path: string,
    schema: z.ZodType<T>,
    jobs: readonly ScopedJobKind[],
    references: readonly QualificationObject[],
    execute: (tx: Tx, ctx: config.ConfigWriteContext, body: T) => Promise<{ items: read.JobLinked[] }>,
  ) =>
    router.post(`${QL_BASE}/${path}/import`, async (c) =>
      withFailedImportLog(deps.db, await importTask(c, deps, object, 'items'), async () => {
        const ctx = await qualificationWriteContext(c, deps, object, 'create', revision(c));
        requireNew(ctx.expectedRevision);
        const body = await parseBody(c, schema);
        const { items: _items, ...fields } = body as Record<string, unknown>;
        await checkWriteFields(deps, ctx, object, 'create', { ...fields, code: null, name: null, jobLinks: [] });
        const w = await writeContext(c, deps, ctx, object, references, jobs);
        return runWrite(c, deps, w, object, body, 201, (tx, x) => execute(tx, x as config.ConfigWriteContext, body), {
          recheck: (value) =>
            requireAllVisible(
              deps,
              w,
              object,
              value.items.map((item) => item.id),
            ),
          present: async (value) => ({ items: await presenter(deps, object)(c, w, value.items) }),
        });
      }),
    );
  importRoute(
    'category',
    'categories',
    input.categoryImport,
    CATEGORY_JOBS,
    ['categoryClass'],
    config.importCategories,
  );
  importRoute('level', 'levels', input.levelImport, LEVEL_JOBS, ['layer'], config.importLevels);
}

function registerGradeDescriptions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 指标等级描述（QL-R7、§5.2 #3）：随指标的读取范围；未手改的描述按等级方案的读取范围与明细字段权给出
  router.get(`${QL_BASE}/targets/:id/grade-descriptions`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'target');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'target');
    const { row, items } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await rowAccess(tx, ctx, scope, 'target', id);
      requireReadable(found.access, 'target');
      return { row: found.row!, items: await targets.gradeDescriptions(tx, ctx.tenantId, id) };
    });
    const schemeId = (row.grade_scheme_id as string | null) ?? null;
    return c.json({ items: await presentGradeDescriptions(c, deps, ctx, schemeId, items) });
  });
  router.put(`${QL_BASE}/targets/:id/grade-descriptions/:detailId`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, 'target', 'update', revision(c));
    const id = uuidParam(c);
    const detailId = uuidParam(c, 'detailId');
    const body = await parseBody(c, input.gradeDescriptionPut);
    await checkWriteFields(deps, ctx, 'targetGradeDescription', 'update', body);
    const w = await writeContext(c, deps, ctx, 'target', []);
    return runWrite(
      c,
      deps,
      w,
      'target',
      body,
      200,
      (tx, x) => targets.putGradeDescription(tx, x, id, detailId, body.description),
      {
        recheck: (value) => requireAllVisible(deps, w, 'target', [value.id]),
        present: async (value) => ({
          revision: value.revision,
          items: await presentGradeDescriptions(c, deps, w, value.gradeSchemeId, value.items),
        }),
      },
    );
  });
}

function registerCodingRules(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 编码规则（QL-R3）：四项，只能编辑；可见范围 = 看全部 ∪ 创建人（DEC-347③）
  router.get(`${QL_BASE}/coding-rules`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'codingRule');
    const scope = await qualificationScope(c, deps, ctx, 'codingRule');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => config.listCodingRules(tx, ctx, scope));
    return c.json({ items: await trimQualification(deps, ctx, 'codingRule', items) });
  });
  router.patch(`${QL_BASE}/coding-rules/:item`, async (c) => {
    const item = c.req.param('item');
    if (!(config.CODING_ITEMS as readonly string[]).includes(item)) throw new AppError('NOT_FOUND', '编码规则不存在');
    const ctx = await qualificationWriteContext(c, deps, 'codingRule', 'update', revision(c));
    const body = await parseBody(c, input.codingRulePatch);
    await checkWriteFields(deps, ctx, 'codingRule', 'update', body);
    const w = await writeContext(c, deps, ctx, 'codingRule', []);
    return runWrite(
      c,
      deps,
      w,
      'codingRule',
      body,
      200,
      (tx, x) => config.updateCodingRule(tx, x, item as config.CodingItem, body),
      {
        recheck: (value) => requireCodingRuleVisible(deps, w, value.id!),
        present: async (value) => (await trimQualification(deps, w, 'codingRule', [value]))[0],
      },
    );
  });
}

/** 编码规则行仍在查看人当前的“看全部 ∪ 创建人”范围内，否则与不存在同一个 404。 */
async function requireCodingRuleVisible(deps: TenantRouteDeps, w: WriteContext, id: string) {
  const visible = await withTenant(deps.db, w.tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT 1 FROM ql_coding_rules t WHERE t.tenant_id = ${w.tenantId}::uuid
        AND t.id = ${id}::uuid AND ${accessSql(w, w.scope, 'dictionary').readable}`),
    ),
  );
  if (!visible.length) throw new AppError('NOT_FOUND', '编码规则不存在');
}

function registerStandardImport(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 编辑导入标准明细（QL-R11、AC-QL-05）：标准的编辑授权 + 按钮；逐标准在请求体里带预期 revision（P2-06），
  // 不用 If-Match（一次导入涉及多条标准）
  router.post(`${QL_BASE}/standards/import`, async (c) =>
    withFailedImportLog(deps.db, await importTask(c, deps, 'standard', 'rows'), async () => {
      const ctx = await qualificationWriteContext(c, deps, 'standard', 'update', 0);
      const body = await parseBody(c, input.standardImport);
      await checkWriteFields(deps, ctx, 'standard', 'update', { details: body.rows });
      const w = await writeContext(c, deps, ctx, 'standard', ['level', 'target']);
      return runWrite(c, deps, w, 'standard', body, 200, (tx, x) => standards.importStandardDetails(tx, x, body), {
        recheck: (value) => requireAllVisible(deps, w, 'standard', value.standardIds),
        present: async ({ standards: count, cells, abilities }) => ({ standards: count, cells, abilities }),
      });
    }),
  );
}

function registerChannels(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 发展通道（QL-R13）：随标准的读取范围与编辑授权
  router.get(`${QL_BASE}/standards/:id/channels`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'developmentChannel');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'standard');
    const view = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, 'standard', id)).access, 'standard');
      return standards.loadChannels(tx, ctx.tenantId, id);
    });
    return c.json(await presentChannels(c, deps, ctx, view));
  });
  router.put(`${QL_BASE}/standards/:id/channels`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, 'developmentChannel', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.channelsPut);
    await checkWriteFields(deps, ctx, 'developmentChannel', 'update', {
      targetCategoryId: null,
      targetLevelId: null,
      levelId: null,
    });
    const w = await writeContext(c, deps, ctx, 'standard', ['category', 'level']);
    return runWrite(c, deps, w, 'standard', body, 200, (tx, x) => standards.putChannels(tx, x, id, body), {
      recheck: (value) => requireAllVisible(deps, w, 'standard', [value.standardId]),
      // 提示只带序号与原因（DEC-347② 🟡），且只给看得到目的地标准的人（第 3 轮 R2-01）
      present: async ({ warnings, ...view }) => ({
        ...(await presentChannels(c, deps, w, view)),
        warnings: await presentWarnings(c, deps, w, warnings),
      }),
    });
  });
}

function registerChart(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 图谱查看（QL-R12）：标准按级别横向拉平；导出在 C1
  router.get(`${QL_BASE}/standards/:id/chart`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'standard');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'standard');
    const { standard, orders } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, 'standard', id)).access, 'standard');
      const [found] = await read.withStandardParts(tx, ctx.tenantId, [
        (await read.loadRow(tx, ctx.tenantId, 'standard', id))!,
      ]);
      const levels = rowsOf<{ id: string; display_order: number }>(
        await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${ctx.tenantId}::uuid
          AND id = ANY(${`{${found!.levelIds.join(',')}}`}::uuid[])`),
      );
      return { standard: found!, orders: new Map(levels.map((level) => [level.id, level.display_order])) };
    });
    return c.json(await presentChart(c, deps, ctx, standard, orders));
  });
}
