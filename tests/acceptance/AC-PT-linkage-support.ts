/**
 * BE-7 PT-7 兼职联动验收共用夹具（docs/08_设计/R2-T05_兼职设计.md §4.8）：在 PT-3a 的服务层夹具之上补“下属员工 / 组织负责人读取 /
 * 联动 outbox 事件读取 / 定时生效运行”。联动的跨对象结果（组织负责人、下属直线经理）一律从读口径取，不看内部状态。
 * 日期框架：今天 2026-10-01，兼职默认 09-01 起；未来开始的联动在开始日由定时生效（employment.activation.run）执行。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { serviceWorld, type ServiceWorld } from './AC-PT-service-support.js';
import { cmd } from './support/tenant-api.js';

export const PENDING = 'employment.part_time.linkage.pending';
export const LINKED = 'employment.part_time.linked';
export const SKIPPED = 'employment.part_time.linkage.skipped';

/** 在已有的服务层 / HTTP 夹具上补联动读写辅助（httpWorld 等都是 serviceWorld 的超集）。 */
export function withLinkage<W extends ServiceWorld>(w: W) {
  const { db } = w;

  /** 在职下属：1 月入职，部门 = 主职部门，直线经理为空。 */
  async function subordinate(name = '下属员工', departmentId = w.primaryOrg.id) {
    const created = await w.employee(name);
    await w.business(
      created.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId } },
      created.revision,
    );
    return created.id;
  }

  /** 组织当前版本的负责人。 */
  const headOf = (orgId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const [row] = rowsOf<{ head: string | null }>(
        await tx.execute(sql`SELECT person_in_charge_id AS head FROM org_versions
          WHERE tenant_id=${w.tenantId} AND org_id=${orgId}::uuid ORDER BY version_no DESC LIMIT 1`),
      );
      return row!.head;
    });
  const orgVersions = (orgId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const [row] = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM org_versions
          WHERE tenant_id=${w.tenantId} AND org_id=${orgId}::uuid`),
      );
      return row!.n;
    });
  /** 员工当前（今天）主职的直线经理。 */
  const managerOf = (employeeId: string, asOf = '2026-10-01') =>
    withTenant(db, w.tenantId, async (tx) => (await findCurrentRecord(tx, w.tenantId, employeeId, asOf))!.fields);

  /** 兼职记录自身保存的联动字段。 */
  const stored = (recordId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const [row] = rowsOf<{ head: boolean | null; subordinates: string[] | null }>(
        await tx.execute(sql`SELECT is_department_head AS head, added_subordinate_ids::text[] AS subordinates
          FROM employment_records WHERE tenant_id=${w.tenantId} AND id=${recordId}::uuid`),
      );
      return row!;
    });

  /** 兼职记录上的联动 outbox 事件（动作名 → 次数）。 */
  const events = (recordId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const rows = rowsOf<{ eventType: string; n: number }>(
        await tx.execute(sql`SELECT event_type AS "eventType", count(*)::int AS n FROM employment_outbox
          WHERE tenant_id=${w.tenantId} AND object_id=${recordId}::uuid AND event_type LIKE 'employment.part_time.%'
          GROUP BY event_type`),
      );
      return Object.fromEntries(rows.map((row) => [row.eventType, row.n])) as Record<string, number>;
    });
  /** 跳过事件的机读原因。 */
  const skipReasons = (recordId: string) =>
    withTenant(db, w.tenantId, async (tx) =>
      rowsOf<{ reason: string }>(
        await tx.execute(sql`SELECT payload->'after'->>'reason' AS reason FROM employment_outbox
          WHERE tenant_id=${w.tenantId} AND object_id=${recordId}::uuid AND event_type=${SKIPPED}`),
      ).map((row) => row.reason),
    );

  /** 定时生效运行（平台入口，租户路径逐员工落地）；返回该租户的运行结果。 */
  async function sweep(date: string) {
    const result = await runEmploymentActivations(
      db,
      cmd(),
      { tenantId: w.tenantId },
      { clock: () => new Date(`${date}T01:00:00.000Z`) },
    );
    return result.runs[0]!;
  }

  /** 可信造数：给兼职记录追加一期（模拟离职钩子把未开始的兼职结束成空区间）。 */
  const endTerm = (recordId: string, termNo: number, endDate: string) =>
    withTenant(db, w.tenantId, (tx) => tx.execute(w.term(recordId, termNo, endDate, 'exit')));

  return { ...w, subordinate, headOf, orgVersions, managerOf, stored, events, skipReasons, sweep, endTerm };
}

export const linkageWorld = async (db: Parameters<typeof serviceWorld>[0], label: string) =>
  withLinkage(await serviceWorld(db, `lk-${label}`));
export type LinkageWorld = Awaited<ReturnType<typeof linkageWorld>>;
