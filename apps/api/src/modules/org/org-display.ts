/**
 * 人员列表 / 名册共用的组织展示（规格 35 §2.2；F-474-4a 自 hr-analysis 下沉，personnel 不反向依赖 hr-analysis）：
 * 机构ID（组织编码）、组织全称与一～三级组织取 asOf 当天的组织版本与行政上级链（resolveOrgPaths，
 * 与组织页同一口径：上级改名不给下级分版本，按查询日的上级名称逐级解析）。一级组织 = 租户根组织下的第一层。
 */
import { sql, type Tx } from '@italent/db';
import { readOrgSettings } from './settings.js';
import { resolveOrgPaths, rowsOf } from './read-model.js';

export interface OrgDisplay {
  /** 机构ID：组织编码（组织页列表同名列）。 */
  readonly code: string;
  readonly fullName: string;
  /** 根组织以下各级名称（下标 0 = 一级组织）。 */
  readonly levels: readonly string[];
}

export async function orgDisplays(
  tx: Tx,
  tenantId: string,
  asOf: string,
  departmentIds: readonly (string | null)[],
): Promise<Map<string, OrgDisplay>> {
  const ids = [...new Set(departmentIds.filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const versions = rowsOf<{ orgId: string; versionId: string; code: string; fullName: string }>(
    await tx.execute(sql`SELECT DISTINCT ON (org_id) org_id AS "orgId", id AS "versionId", code,
      full_name AS "fullName"
      FROM org_versions WHERE tenant_id=${tenantId} AND org_id=ANY(${`{${ids.join(',')}}`}::uuid[])
        AND start_date<=${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC`),
  );
  const paths = await resolveOrgPaths(
    tx,
    tenantId,
    asOf,
    versions.map((version) => version.versionId),
  );
  const startLevel = (await readOrgSettings(tx, tenantId)).fullNameStartLevel;
  return new Map(
    versions.map((version) => {
      // 行政上级链不完整时退回版本上存的全称（同 resolveOrgPaths 的约定）
      const names = (paths.get(version.versionId)?.fullName ?? version.fullName).split('/');
      return [
        version.orgId,
        {
          code: version.code,
          fullName: names.slice(startLevel).join('/'),
          levels: names.slice(1),
        } satisfies OrgDisplay,
      ];
    }),
  );
}
