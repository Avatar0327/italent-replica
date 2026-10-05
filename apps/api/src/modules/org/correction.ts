/**
 * DEC-147（`10` §18 W-439～W-442）：组织建成后可在「编辑」（更正、不产生新版本）中修改设立日期，首版生效日随之变化，
 * DEC-130“首版生效日 = 设立日期”始终成立；「变更」中没有该字段。保存时照搬原站两条拦截——①须早于后一个版本的
 * 生效日；②不得早于上级组织的设立日——另加③不得晚于本组织最早一条任职 / 职位记录的开始日（复刻加严，与 DEC-138 同向）。
 * 组织版本只允许追加（迁移 0008 / 0009），这是唯一的原地更正：迁移 0038 只放行事务内声明后改 start_date / established_on。
 * 更正本身不追加任何版本；全称按当天的上级名称在读取时解析（read-model 的 resolveOrgPaths），不需要派生版本。
 */
import { and, asc, eq, orgVersions, sql, type Tx } from '@italent/db';
import { ORG_DIMENSIONS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { assertParentAvailable } from './deactivation.js';
import { loadOrgSnapshot, type OrgRecord, rowsOf } from './read-model.js';
import type { OrgWriteContext } from './validation.js';

export interface EstablishedOnCorrection {
  /** 更正前的首版记录（审计与上级判断用）。 */
  readonly before: OrgRecord;
  /** 原设立日期（= 原首版生效日）。 */
  readonly previous: string;
  readonly establishedOn: string;
}

function rejected(reason: string, message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_FAILED', message, { reason, fields: { establishedOn: message }, ...details });
}

async function earliest(tx: Tx, query: SQL): Promise<string | null> {
  const [row] = rowsOf<{ day: string | null }>(await tx.execute(query));
  return row?.day ?? null;
}

/** 校验更正并返回计划；设立日期与首版生效日都不变时返回 null（不写入、不前进 revision）。 */
export async function planEstablishedOnCorrection(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  establishedOn: string,
): Promise<EstablishedOnCorrection | null> {
  const versions = await tx
    .select({
      startDate: orgVersions.startDate,
      stopDate: orgVersions.stopDate,
      establishedOn: orgVersions.establishedOn,
    })
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, ctx.tenantId), eq(orgVersions.orgId, orgId)))
    .orderBy(asc(orgVersions.startDate), asc(orgVersions.versionNo));
  const previous = versions[0]?.startDate;
  if (!previous) throw new AppError('NOT_FOUND', '组织不存在');
  if (establishedOn === previous && versions.every((row) => row.establishedOn === establishedOn)) return null;
  // ①的“后一条组织记录”都是本组织自己的业务版本：上级改名、移动不再给下级追加派生全称版本（PR #54 P2-A）。
  const next = versions.find((row) => row.startDate > previous)?.startDate;
  if (next && establishedOn >= next) {
    throw rejected(
      'ESTABLISHED_ON_NOT_BEFORE_NEXT_VERSION',
      `请将设立日期调整至 ${next} 之前——设立日期须早于后一条组织记录的生效日期（${next}）`,
      { limit: next },
    );
  }
  const stop = versions
    .filter((row) => row.startDate === previous)
    .reduce((min, row) => (row.stopDate < min ? row.stopDate : min), '9999-12-31');
  if (establishedOn > stop) {
    throw rejected('ESTABLISHED_ON_AFTER_STOP_DATE', `请将设立日期调整至 ${stop} 及以前——不得晚于组织的失效日期`, {
      limit: stop,
    });
  }
  const [before] = await loadOrgSnapshot(tx, ctx.tenantId, previous, undefined, { id: orgId });
  if (!before) throw new AppError('SERVICE_UNAVAILABLE', '组织首个版本不可用');
  await assertNotBeforeParents(tx, ctx, before, previous, establishedOn);
  if (establishedOn > previous) await assertNothingBefore(tx, ctx, orgId, establishedOn);
  if (establishedOn < previous) {
    // DEC-129：提前的这段时间里，启用的组织同样不能挂在停用或失效的行政上级下。
    const stopDate = dayBefore(previous);
    const firstPeriod = { parents: before.parents, enabled: before.enabled, startDate: establishedOn, stopDate };
    await assertParentAvailable(tx, ctx, firstPeriod);
    await assertCodeFree(tx, ctx, orgId, before.code, establishedOn, previous);
  }
  return { before, previous, establishedOn };
}

/** ②：各维度上级的设立日（首版生效日）不得晚于新设立日；租户根自 0001-01-01 起，不会拦截。 */
async function assertNotBeforeParents(
  tx: Tx,
  ctx: OrgWriteContext,
  before: OrgRecord,
  previous: string,
  establishedOn: string,
): Promise<void> {
  for (const dimension of ORG_DIMENSIONS) {
    const parentId = before.parents[dimension]?.parentId;
    if (!parentId) continue;
    const parentStart = await earliest(
      tx,
      sql`SELECT min(start_date)::text AS day FROM org_versions
        WHERE tenant_id=${ctx.tenantId} AND org_id=${parentId}::uuid`,
    );
    if (!parentStart || establishedOn >= parentStart) continue;
    const [parent] = await loadOrgSnapshot(tx, ctx.tenantId, previous, undefined, { id: parentId });
    throw rejected(
      'ESTABLISHED_ON_BEFORE_PARENT',
      `请将设立日期调整至 ${parentStart} 及以后——设立日期须晚于等于上级组织【${parent?.name ?? parentId}】的设立日期` +
        `（${parentStart}），若需调整，请同时调整该组织全部上级组织的设立日期`,
      { limit: parentStart, parentId, dimension },
    );
  }
}

/** ③（复刻加严）：推迟设立日不得越过本组织已有的任职、职位记录，也不得越过已挂在本组织下的下级组织。 */
async function assertNothingBefore(tx: Tx, ctx: OrgWriteContext, orgId: string, establishedOn: string) {
  const employment = await earliest(
    tx,
    sql`SELECT min(t.start_date)::text AS day FROM employment_records r
      JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
      LEFT JOIN LATERAL (
        SELECT p.id, p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1
      ) latest ON true
      WHERE r.tenant_id=${ctx.tenantId}
        AND (CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END)=${orgId}::uuid`,
  );
  const position = await earliest(
    tx,
    sql`SELECT min(start_date)::text AS day FROM job_position_versions
      WHERE tenant_id=${ctx.tenantId} AND org_id=${orgId}::uuid`,
  );
  const records = [employment, position].filter((day): day is string => !!day).sort()[0];
  if (records && establishedOn > records) {
    throw rejected(
      'ESTABLISHED_ON_AFTER_RECORDS',
      `请将设立日期调整至 ${records} 及以前——本组织已有自 ${records} 起的任职或职位记录`,
      { limit: records },
    );
  }
  const child = await earliest(
    tx,
    sql`SELECT min(v.start_date)::text AS day FROM org_versions v
      JOIN org_hierarchy_links h ON h.tenant_id=v.tenant_id AND h.version_id=v.id
      WHERE v.tenant_id=${ctx.tenantId} AND h.parent_org_id=${orgId}::uuid AND v.org_id<>${orgId}::uuid`,
  );
  if (child && establishedOn > child) {
    throw rejected(
      'ESTABLISHED_ON_AFTER_CHILD',
      `请将设立日期调整至 ${child} 及以前——已有下级组织自 ${child} 起挂在本组织下`,
      { limit: child },
    );
  }
}

/** 编码按版本可复用（DEC-072）：提前到的这段时间里，编码不得与其他组织当时有效的版本重复。 */
async function assertCodeFree(tx: Tx, ctx: OrgWriteContext, orgId: string, code: string, from: string, to: string) {
  const [taken] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM (
        SELECT org_id, code, start_date,
          LEAST(stop_date, COALESCE(lead(start_date) OVER (PARTITION BY org_id ORDER BY start_date, version_no) - 1,
            stop_date)) AS end_date
        FROM org_versions WHERE tenant_id=${ctx.tenantId}
      ) v
      WHERE v.code=${code} AND v.org_id<>${orgId}::uuid AND v.end_date >= v.start_date
        AND v.start_date < ${to}::date AND v.end_date >= ${from}::date
      LIMIT 1
    `),
  );
  if (taken) throw new AppError('CONFLICT', '机构编码在提前后的期间内已被其他组织使用', { reason: 'CODE_CONFLICT' });
}

/**
 * 原地更正：首版（含同日被取代的版本）的生效日改为新设立日，全部版本的设立日期一起改；排序名次由迁移 0027 的触发器
 * 在同一事务内刷新。声明只在本事务内有效，用完立即撤销。
 */
export async function applyEstablishedOnCorrection(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  plan: EstablishedOnCorrection,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('italent.org_correction', 'established_on', true)`);
  if (plan.establishedOn !== plan.previous) {
    await tx.execute(sql`UPDATE org_versions SET start_date=${plan.establishedOn}::date
      WHERE tenant_id=${ctx.tenantId} AND org_id=${orgId}::uuid AND start_date=${plan.previous}::date`);
  }
  await tx.execute(sql`UPDATE org_versions SET established_on=${plan.establishedOn}::date
    WHERE tenant_id=${ctx.tenantId} AND org_id=${orgId}::uuid
      AND established_on IS DISTINCT FROM ${plan.establishedOn}::date`);
  await tx.execute(sql`SELECT set_config('italent.org_correction', '', true)`);
}

function dayBefore(value: string): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
