import { sql, withTenant, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { rowsOf } from '../employment/read-model.js';
import { objectContext } from '../permission/module-route-access.js';
import { dateQuery } from './hr-dashboard-routes.js';

export const ORGANIZATION_CANDIDATES_PATH = '/api/tenant/analytics/organization-candidates';
export const ANALYSIS_CANDIDATE_OBJECTS = {
  HrDashboard: MODULE_OBJECTS.hrDashboard.code,
  HrStructure: MODULE_OBJECTS.hrStructure.code,
  HrMovement: MODULE_OBJECTS.hrMovement.code,
  HrProcessDashboard: MODULE_OBJECTS.hrProcessDashboard.code,
  ContractBoard: MODULE_OBJECTS.contractBoard.code,
  HrRoster: MODULE_OBJECTS.hrRoster.code,
  HrStructureReport: MODULE_OBJECTS.hrStructureReport.code,
  HrMovementReport: MODULE_OBJECTS.hrMovementReport.code,
} as const;

type AnalysisObject = keyof typeof ANALYSIS_CANDIDATE_OBJECTS;

interface OrganizationCandidate {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly enabled: boolean;
}

/** DEC-961：筛选树按租户时点列出行政节点，包含停用版本。只从数据库读取候选所需字段。 */
async function readOrganizationCandidates(tx: Tx, tenantId: string, asOf: string) {
  return rowsOf<OrganizationCandidate>(
    await tx.execute(sql`
      SELECT v.org_id AS id, v.name, l.parent_org_id AS "parentId", v.enabled
      FROM (
        SELECT DISTINCT ON (org_id) id, org_id, name, enabled, stop_date
        FROM org_versions
        WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
        ORDER BY org_id, start_date DESC, version_no DESC
      ) v
      LEFT JOIN org_hierarchy_links l
        ON l.tenant_id = ${tenantId} AND l.version_id = v.id AND l.dimension = 'admin'
      WHERE v.stop_date >= ${asOf}::date
      ORDER BY v.org_id
    `),
  );
}

function organizationCandidateObject(c: Context): AnalysisObject {
  const object = c.req.query('object') as AnalysisObject | undefined;
  if (!object || !Object.hasOwn(ANALYSIS_CANDIDATE_OBJECTS, object)) {
    throw new AppError('VALIDATION_FAILED', 'object 必须为受支持的人事分析对象');
  }
  return object;
}

export function registerOrganizationCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(ORGANIZATION_CANDIDATES_PATH, async (c) => {
    const object = organizationCandidateObject(c);
    const ctx = await objectContext(c, deps, ANALYSIS_CANDIDATE_OBJECTS[object], 'view');
    const asOf = dateQuery(c, 'asOf') ?? tenantLocalDate(ctx.now, ctx.timezone);
    // FE-R2f §3.1、U2：全租户候选只服务于筛选，统计接口按自身的数据范围取数。
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => readOrganizationCandidates(tx, ctx.tenantId, asOf));
    return c.json({ items });
  });
}
