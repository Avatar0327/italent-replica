/**
 * 继任对外端口的装配登记位（R3-T05 设计 §6.3；同步协议 SP-15）：createApp 装配本模块时调用 installSuccessionPorts，
 * D4 把健康度计算端口登记给 T04；计算直接复用 B5 宿主。
 * 实现必须是模块级单例：createApp 每装配一次都会调用本函数，T04 只接受同一实例的重复登记。
 */
import type { TenantRouteDeps } from '../../routes.js';
import type { SyncDeps } from './sync-consume.js';
import { sql, type Tx, type Db } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { registerOrgHealthComputePort, type OrgHealthComputePort } from '../talent-review/health-port.js';
import { loadIncumbentIds, loadPeople, rowsOf, type PersonView } from './read-sql.js';
import { healthComputePort, type HealthReads } from './health-compute.js';
import { createInMemoryTalentReviewSyncPort } from '../talent-review/sync-port-memory.js';

export interface SuccessionPorts {
  readonly riskPartTimeIncumbents?: (ctx: SuccessionReadContext, positionId: string) => Promise<readonly string[]>;
  readonly orgHealthCompute?: OrgHealthComputePort;
  readonly reviewReads?: HealthReads;
}

export const SUCCESSION_PORTS: SuccessionPorts = { orgHealthCompute: healthComputePort };

/** T04 PR-D 真实端口接线前按 SP-18 替身取数，无来源返回 unavailable / null，不伪造 0%。 */
export function successionReviewReads(tenantId: string) {
  return SUCCESSION_PORTS.reviewReads ?? createInMemoryTalentReviewSyncPort({ tenantId });
}

export function installSuccessionPorts(ports: SuccessionPorts = SUCCESSION_PORTS): void {
  if (ports.orgHealthCompute) registerOrgHealthComputePort(ports.orgHealthCompute);
}

/**
 * 给 R3-T06 人才池的读端口（设计 §6.3）。可信端口，同准备度字典端口：在调用方的租户事务内执行（RLS 只读到当前租户），
 * **可信端口，调用方负责范围 / 字段 / SELF 裁剪**（DEC-368②，与 DEC-320⑥ / Q-T02-16 一致）：端口不做查看人的权限判断、
 * SELF 过滤与字段裁剪，T06 接线时按自己的对象权限与范围决定对外披露什么；只给业务口径：
 * asOf 当日生效（start_date ≤ asOf < end_date）、未删除。
 */
export interface SuccessionReadContext {
  readonly tx: Tx;
  readonly tenantId: string;
  /** 业务日期（租户时区），由调用方给出。 */
  readonly asOf: string;
}

export interface ActiveSuccessorFilter {
  readonly successionType?: 'org' | 'position';
  readonly targetOrgIds?: readonly string[];
  readonly targetPositionIds?: readonly string[];
  readonly successorEmployeeIds?: readonly string[];
}

export interface ActiveSuccessor {
  readonly recordId: string;
  readonly successionType: 'org' | 'position';
  readonly targetOrgId: string | null;
  readonly targetPositionId: string | null;
  readonly successorEmployeeId: string;
  readonly readinessId: string | null;
  readonly backupType: string;
  readonly startDate: string;
}

const uuidList = (ids: readonly string[]) => sql`ANY(${`{${ids.join(',')}}`}::uuid[])`;

/** asOf 当日生效的继任记录；过滤数组给了但为空 = 没有匹配，直接返回空。 */
export async function listActiveSuccessors(
  ctx: SuccessionReadContext,
  filter: ActiveSuccessorFilter = {},
): Promise<readonly ActiveSuccessor[]> {
  const lists = [filter.targetOrgIds, filter.targetPositionIds, filter.successorEmployeeIds];
  if (lists.some((ids) => ids !== undefined && ids.length === 0)) return [];
  const where: SQL[] = [
    sql`tenant_id = ${ctx.tenantId}::uuid`,
    sql`deleted_at IS NULL`,
    sql`start_date <= ${ctx.asOf}::date`,
    sql`end_date > ${ctx.asOf}::date`,
  ];
  if (filter.successionType) where.push(sql`succession_type = ${filter.successionType}`);
  if (filter.targetOrgIds) where.push(sql`target_org_id = ${uuidList(filter.targetOrgIds)}`);
  if (filter.targetPositionIds) where.push(sql`target_position_id = ${uuidList(filter.targetPositionIds)}`);
  if (filter.successorEmployeeIds) where.push(sql`successor_employee_id = ${uuidList(filter.successorEmployeeIds)}`);
  const rows = rowsOf<Record<string, string | null>>(
    await ctx.tx.execute(sql`SELECT id, succession_type, target_org_id, target_position_id, successor_employee_id,
        readiness_id, backup_type, start_date::text AS start_date
      FROM succession_records WHERE ${sql.join(where, sql` AND `)} ORDER BY start_date, id`),
  );
  return rows.map((row) => ({
    recordId: row.id!,
    successionType: row.succession_type as 'org' | 'position',
    targetOrgId: row.target_org_id ?? null,
    targetPositionId: row.target_position_id ?? null,
    successorEmployeeId: row.successor_employee_id!,
    readinessId: row.readiness_id ?? null,
    backupType: row.backup_type!,
    startDate: row.start_date!,
  }));
}

/** 职位现任（asOf 当日主职任职，人员状态不是待入职 / 调出 / 退休 / 离职）：职位 ID → 现任（姓名、邮箱）；空缺职位无键。 */
export async function listIncumbents(
  ctx: SuccessionReadContext,
  positionIds: readonly string[],
): Promise<ReadonlyMap<string, readonly PersonView[]>> {
  const incumbents = await loadIncumbentIds(ctx.tx, ctx.tenantId, positionIds, ctx.asOf);
  const people = await loadPeople(ctx.tx, ctx.tenantId, [...incumbents.values()].flat());
  return new Map([...incumbents].map(([positionId, ids]) => [positionId, ids.flatMap((id) => people.get(id) ?? [])]));
}

/** D3：真实端口另行接线；不安装替身作为生产默认值。按 Db 隔离应用/测试实例。 */
const syncProviders = new WeakMap<Db, (deps: TenantRouteDeps) => SyncDeps>();
export function registerSuccessionSync(db: Db, factory: (deps: TenantRouteDeps) => SyncDeps) {
  syncProviders.set(db, factory);
}
export function getSuccessionSync(deps: TenantRouteDeps) {
  return syncProviders.get(deps.db)?.(deps);
}
