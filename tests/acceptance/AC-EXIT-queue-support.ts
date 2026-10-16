/**
 * R2-T03 B1b 验收夹具：直接在库里造“已批准未落地”的合成申请（只含队列排序所需的载荷版本与状态事件），
 * 用来对照 SQL 队列与纯函数（execution-order.ts / planned-date.ts）。不经业务入口，故可造出任意 kind 与任意版本序列。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { addDays, resolvePlannedEffectiveDate, type ExecutionKind, type PlanVersion } from '@italent/domain';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import type { ActivationWorld } from './AC-TRF-activation-support.js';

export interface SyntheticApplication {
  readonly kind: ExecutionKind;
  /** 载荷版本序列，version_no 从 1 起；全部版本共用同一 created_at（同一事务写出的情形）。 */
  readonly versions: readonly PlanVersion[];
  /** 操作先后（DEC-108）：最近一次提交事件的 event_seq；null 表示没有提交事件（取第一条事件）。 */
  readonly submitSeq: number;
}

/** 新建业务头、按序追加载荷版本，再写 in_review → approved 两条状态事件。复制员工首个载荷版本的必填列。 */
export async function insertApprovedApplication(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  application: SyntheticApplication,
): Promise<string> {
  const businessId = randomUUID();
  await tx.execute(sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
    VALUES (${businessId}::uuid,${tenantId},${employeeId}::uuid)`);
  let previous: string | null = null;
  for (const version of application.versions) {
    const id = randomUUID();
    const trigger = version.manual ? null : businessId;
    await tx.execute(sql`
      INSERT INTO employment_payload_versions
        (id,tenant_id,employee_id,business_id,version_no,previous_version_id,command_id,trigger_business_id,
         kind,mode,effective_date,form_id,employ_type,created_at)
      SELECT ${id}::uuid,tenant_id,employee_id,${businessId}::uuid,${version.versionNo},${previous}::uuid,
        ${trigger === null ? null : 'queue-derived'},${trigger}::uuid,${application.kind},'application',
        ${version.effectiveDate}::date,form_id,employ_type,'2026-10-01T01:00:00Z'::timestamptz
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
        AND business_id<>${businessId}::uuid
      ORDER BY created_at, version_no LIMIT 1`);
    previous = id;
  }
  const latest = previous;
  await tx.execute(sql`
    INSERT INTO employment_state_events
      (tenant_id,employee_id,business_id,payload_version_id,state,event_no,command_id,event_seq)
    VALUES (${tenantId},${employeeId}::uuid,${businessId}::uuid,${latest}::uuid,'in_review',1,'queue-submit',
        ${application.submitSeq}),
      (${tenantId},${employeeId}::uuid,${businessId}::uuid,${latest}::uuid,'approved',2,'queue-approve',
        ${application.submitSeq + 100000})`);
  return businessId;
}

export function manual(versionNo: number, effectiveDate: string): PlanVersion {
  return { versionNo, effectiveDate, manual: true };
}

export function derived(versionNo: number, effectiveDate: string): PlanVersion {
  return { versionNo, effectiveDate, manual: false };
}

/** 确定性伪随机，保证失败可复现。 */
export function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

export const pad = (day: number) => String(day).padStart(2, '0');

export const TODAY = '2026-10-18';

/** 队列读取用的命令上下文：今天 = today（租户日）。 */
export function queueContext(w: ActivationWorld, today = TODAY): EmploymentContext {
  return {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date(`${today}T01:00:00Z`),
    commandId: 'queue-read',
    expectedRevision: 0,
  };
}

export const plannedOf = (versions: readonly PlanVersion[]) =>
  resolvePlannedEffectiveDate({ versions, fallback: '1900-01-01' });
export const lastVersion = (versions: readonly PlanVersion[]) =>
  [...versions].sort((a, b) => b.versionNo - a.versionNo)[0]!;

/**
 * 可达的随机申请：任意次人工改期（draft / 审批前），调动审批后至多一次迟到顺延（写入的日期是某个已过的执行日，≤ 今天），
 * 其余 kind 不顺延（main 只有调动会改写载荷生效日）。
 */
export function randomApplication(
  random: () => number,
  kinds: readonly ExecutionKind[],
  submitSeq: number,
  today = TODAY,
): SyntheticApplication {
  const kind = kinds[Math.floor(random() * kinds.length)]!;
  const day = () => `2026-10-${pad(10 + Math.floor(random() * 14))}`;
  const count = 1 + Math.floor(random() * 3);
  const versions: PlanVersion[] = Array.from({ length: count }, (_unused, index) => manual(index + 1, day()));
  const planned = lastVersion(versions).effectiveDate;
  if (kind === 'transfer' && planned < today && random() < 0.7) {
    const span = Date.parse(today) / 86400000 - Date.parse(planned) / 86400000;
    versions.push(derived(count + 1, addDays(planned, Math.floor(random() * (span + 1)))));
  }
  return { kind, versions, submitSeq };
}

export async function seedQueue(w: ActivationWorld, employeeId: string, applications: readonly SyntheticApplication[]) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const ids: string[] = [];
    for (const application of applications)
      ids.push(await insertApprovedApplication(tx, w.session.tenant.id, employeeId, application));
    return ids;
  });
}
