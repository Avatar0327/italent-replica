/**
 * BE-11b 组织明细执行世界：在审批世界上走“建单 → 明细 → 提交 → 两节点同意（入队）→ 执行器”。执行器不注入明细执行器
 * （用产品默认），只注入申请人三层范围（申请单 / 组织 / 任职对象），由 `access` 控制；读写一律在对应租户的 withTenant 内。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import {
  runOrgAdjustmentTenant,
  type RunnerOptions,
} from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { RUNNER_LEASE_MS } from '../../apps/api/src/modules/org-adjustment/runner-lease.js';
import type { ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { flowWorld, type FlowOptions } from './AC-OA-approval-support.js';
import { ALL, MAIN, ORG } from './AC-OA-head-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

export const EMP = 'TenantBase.EmploymentRecord';
export const E = '2026-11-01';

export interface ItemOutcome {
  readonly id: string;
  readonly seq: number;
  readonly execution_result: number | null;
  readonly exec_phase: number;
  readonly execution_reason: string | null;
  readonly execution_message: string | null;
  readonly created_org_id: string | null;
  readonly executed_version_id: string | null;
  readonly employment_done: number;
  readonly employment_failed: number;
  readonly is_staged: boolean;
}

export interface OrgAt {
  readonly name: string;
  readonly enabled: boolean;
  readonly version_no: number;
  readonly version_id: string;
  readonly parent_id: string | null;
}

export interface RecordRow {
  readonly kind: string;
  readonly change_type: string | null;
  readonly start_date: string;
  readonly department_id: string | null;
  readonly service_type: string;
}

export async function execWorld(db: Db, label: string, options: FlowOptions = {}) {
  const w = await flowWorld(db, label, options);
  const scopes: { employment: ModuleScope } = { employment: ALL };
  /** 申请人三层范围（§6.3“执行”列）：按对象取 access.main / access.org / scopes.employment。 */
  const scopeOf = async (_tx: unknown, q: { objectCode: string }) =>
    q.objectCode === MAIN ? w.access.main : q.objectCode === ORG ? w.access.org : scopes.employment;
  const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
  /** 不传 executors：用产品默认的组织明细执行器；scopeOf 经变量传入（不是新鲜字面量）。 */
  const run = (over: RunnerOptions = {}) => {
    const runOptions = { holderToken: `p-${randomUUID()}`, scopeOf, ...over };
    return runOrgAdjustmentTenant(db, tenant, w.clock, runOptions);
  };

  async function staff(departmentId: string, name = `ZZ_员工${uniqueSuffix()}`) {
    const created = await w.employee(name);
    await w.hire(created.id, { departmentId });
    return created.id;
  }

  /** 建单 + 明细（按给出顺序）+ 提交 + 两节点同意；返回单 ID 与各用户明细行 ID（按 seq）。 */
  async function approved(range: readonly string[], items: readonly Record<string, unknown>[]) {
    const view = await w.created(w.headBody({ adjustmentRange: range }));
    for (const item of items) await w.item(view.id, item);
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');
    const rows = await w.rows(view.id);
    return { id: view.id, itemIds: rows.filter((r) => !r.cascaded_from_item_id).map((r) => r.id), rows };
  }

  async function outcomes(adjustmentId: string): Promise<Map<string, ItemOutcome>> {
    const rows = await withTenant(db, w.tenant.id, async (tx) =>
      resultRows<ItemOutcome>(
        await tx.execute(sql`SELECT id, seq, execution_result, exec_phase, execution_reason, execution_message,
            created_org_id, executed_version_id, employment_done, employment_failed, is_staged
          FROM org_adjustment_org_items WHERE adjustment_id=${adjustmentId} ORDER BY seq`),
      ),
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** 单头执行结果（`head` 在审批世界里是主体组织负责人，故另名）。 */
  async function headRow(adjustmentId: string) {
    return withTenant(db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{
        approval_status: number;
        execution_status: number;
        success_count: number | null;
        failure_count: number | null;
        execution_note: string | null;
        data_volume: number | null;
        pauses: number;
      }>(
        await tx.execute(sql`SELECT approval_status, execution_status, success_count, failure_count, execution_note,
            data_volume, (SELECT count(*) FROM org_adjustment_pauses p WHERE p.adjustment_id=a.id)::int AS pauses
          FROM org_adjustments a WHERE a.id=${adjustmentId}`),
      );
      return row!;
    });
  }

  /** 组织在某日的现行版本（含停用）与行政上级。 */
  async function orgAt(orgId: string, date = E): Promise<OrgAt | undefined> {
    return withTenant(db, w.tenant.id, async (tx) => {
      const [row] = resultRows<OrgAt>(
        await tx.execute(sql`SELECT v.name, v.enabled, v.version_no, v.id AS version_id, h.parent_org_id AS parent_id
          FROM org_versions v LEFT JOIN org_hierarchy_links h ON h.version_id=v.id AND h.dimension='admin'
          WHERE v.org_id=${orgId} AND v.start_date<=${date}::date
          ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
      );
      return row;
    });
  }

  async function versionCount(orgId: string) {
    return withTenant(db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM org_versions WHERE org_id=${orgId}`),
      );
      return row!.n;
    });
  }

  async function records(employeeId: string): Promise<RecordRow[]> {
    return withTenant(db, w.tenant.id, async (tx) =>
      resultRows<RecordRow>(
        await tx.execute(sql`SELECT kind, change_type, start_date::text, department_id, service_type
          FROM employment_records WHERE employee_id=${employeeId} ORDER BY start_date, created_at`),
      ),
    );
  }

  async function failures(adjustmentId: string) {
    return withTenant(db, w.tenant.id, async (tx) =>
      resultRows<{ item_id: string; employee_id: string; reason: string }>(
        await tx.execute(sql`SELECT item_id, employee_id, reason FROM org_adjustment_employment_failures
          WHERE adjustment_id=${adjustmentId} ORDER BY employee_id`),
      ),
    );
  }

  async function orgRevision(orgId: string) {
    return withTenant(db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM org_objects WHERE id=${orgId}`),
      );
      return row!.revision;
    });
  }

  /** 指定设立日期建组织（行政上级 parentId）。 */
  async function orgOn(name: string, parentId: string, establishedOn: string) {
    const res = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name, establishedOn, parents: { admin: { parentId } } },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  /** 直接改组织（组织模块 PATCH，不经组织调整）。 */
  async function patchOrg(orgId: string, body: Record<string, unknown>) {
    return w.call('PATCH', `/api/tenant/org/organizations/${orgId}`, { ifMatch: await orgRevision(orgId), body });
  }

  /** 租约过期后接管：把时钟推过租约。 */
  function advance(ms = RUNNER_LEASE_MS + 60_000) {
    w.setNow(new Date(w.clock().getTime() + ms).toISOString());
  }

  return {
    ...w,
    scopes,
    scopeOf,
    tenant,
    run,
    staff,
    approved,
    outcomes,
    headRow,
    orgAt,
    versionCount,
    records,
    failures,
    orgRevision,
    orgOn,
    patchOrg,
    advance,
  };
}

export type ExecWorld = Awaited<ReturnType<typeof execWorld>>;

/** 可信夹具：按种子员工的真实入职行批量复制合成员工（同 AC-ORG-30），返回新员工 ID。 */
export async function cloneStaff(db: Db, tenantId: string, seedEmployeeId: string, count: number) {
  const people = Array.from({ length: count }, () => ({
    employee: randomUUID(),
    business: randomUUID(),
    payload: randomUUID(),
    staff: randomUUID(),
    code: `ZZ${randomUUID().replaceAll('-', '')}`,
  }));
  await withTenant(db, tenantId, async (tx) => {
    const [origin] = resultRows<{ record: string; staff: string; payload: string }>(
      await tx.execute(sql`SELECT id AS record, staff_id AS staff, payload_version_id AS payload
        FROM employment_records WHERE employee_id=${seedEmployeeId} AND kind='hire'`),
    );
    const rows = sql`jsonb_to_recordset(${JSON.stringify(people)}::jsonb)
      AS c(employee uuid,business uuid,payload uuid,staff uuid,code text)`;
    const copies = [
      ['employment_employees', seedEmployeeId, sql`jsonb_build_object('id',c.employee,'code',c.code)`],
      [
        'employment_business_objects',
        origin!.record,
        sql`jsonb_build_object('id',c.business,'employee_id',c.employee)`,
      ],
      ['employment_cycles', origin!.staff, sql`jsonb_build_object('id',c.staff,'employee_id',c.employee)`],
      [
        'employment_payload_versions',
        origin!.payload,
        sql`jsonb_build_object('id',c.payload,'business_id',c.business,'employee_id',c.employee,'job_number',c.code)`,
      ],
      [
        'employment_records',
        origin!.record,
        sql`jsonb_build_object('id',c.business,'employee_id',c.employee,'payload_version_id',c.payload,
          'staff_id',c.staff,'job_number',c.code)`,
      ],
    ] as const;
    for (const [table, id, replacements] of copies)
      await tx.execute(sql`INSERT INTO ${sql.identifier(table)}
        SELECT (jsonb_populate_record(NULL::${sql.identifier(table)},to_jsonb(s)||${replacements})).*
        FROM ${sql.identifier(table)} s CROSS JOIN ${rows}
        WHERE s.tenant_id=${tenantId} AND s.id=${id}::uuid`);
    await tx.execute(sql`INSERT INTO employment_timeline
      SELECT (jsonb_populate_record(NULL::employment_timeline,to_jsonb(s)||jsonb_build_object(
        'employee_id',c.employee,'record_id',c.business,'staff_id',c.staff))).*
      FROM employment_timeline s CROSS JOIN ${rows}
      WHERE s.tenant_id=${tenantId} AND s.record_id=${origin!.record}::uuid`);
  });
  return people.map((p) => p.employee);
}
