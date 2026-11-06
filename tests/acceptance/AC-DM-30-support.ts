/**
 * F-139a 历史离职人员导入验收夹具（docs/08_设计/F-139_历史离职人员导入_设计.md §4.2 / §12）。
 * 日期设定：今天 2026-11-05；入职日 H = 2023-03-01，最后工作日 L = 2025-06-30，离职生效日 E = L + 1 = 2025-07-01。
 * 数据全部合成：工号 H0001 起，姓名「合成甲 / 乙」；部门编码带 uniqueSuffix。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { forceDisableOrg } from './AC-EST-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { uniqueSuffix } from './support/unique.js';
import type { Db } from '@italent/db';

export const TODAY = '2026-11-05';
export const H = '2023-03-01';
export const L = '2025-06-30';
export const E = '2025-07-01';

export interface ImportRow {
  rowNo?: number;
  employeeNo: string;
  name: string;
  entryDate: string;
  departmentCode: string;
  lastWorkDate: string;
  [key: string]: unknown;
}

export async function importWorld(db: Db, label: string) {
  const w = await gateWorld(db, `dm30-${label}`, { today: TODAY });
  const tenantId = w.session.tenant.id;

  /** 设立日早于 H 的合成部门；code 供导入行引用。 */
  async function dept(name: string, extra: Record<string, unknown> = {}) {
    const code = `D${uniqueSuffix(12)}`;
    const org = await w.session.org(name, { code, establishedOn: '2022-01-01', ...extra });
    return { ...org, code };
  }
  const row = (n: number, departmentCode: string, extra: Record<string, unknown> = {}): ImportRow => ({
    rowNo: n,
    employeeNo: `H${String(n).padStart(4, '0')}`,
    name: n % 2 ? '合成甲' : '合成乙',
    entryDate: H,
    departmentCode,
    lastWorkDate: L,
    exitTypeCode: 'voluntary',
    ...extra,
  });
  const send = (path: string, body: unknown, options: Record<string, unknown> = {}) =>
    w.session.request('POST', path, { body, ...options });
  const preview = (rows: readonly ImportRow[], extra: Record<string, unknown> = {}) =>
    send('/exits/import/preview', { rows, ...extra });
  const importRows = (rows: readonly ImportRow[], extra: Record<string, unknown> = {}, options = {}) =>
    send('/exits/import', { rows, ...extra }, options);

  const q = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => rowsOf<T>(await tx.execute(statement)));
  const employeeByNo = async (no: string) =>
    (await q<{ id: string }>(sql`SELECT id FROM employment_employees WHERE tenant_id=${tenantId} AND code=${no}`))[0];
  const employeeCount = async () =>
    Number(
      (
        await q<{ n: string }>(sql`SELECT count(*) AS n FROM employment_employees WHERE tenant_id=${tenantId}
        AND code LIKE 'H%'`)
      )[0]!.n,
    );
  const businessesOf = (employeeId: string) =>
    q<{ id: string; kind: string; state: string; effectiveDate: string; mode: string }>(sql`
      SELECT b.id, p.kind, p.mode, p.effective_date::text AS "effectiveDate",
        (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
          ORDER BY event_no DESC LIMIT 1) AS state
      FROM employment_business_objects b JOIN employment_payload_versions p
        ON p.tenant_id=b.tenant_id AND p.business_id=b.id AND p.version_no=1
      WHERE b.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid ORDER BY p.effective_date`);
  const statesOf = async (businessId: string) =>
    (
      await q<{ state: string }>(sql`SELECT state FROM employment_state_events WHERE tenant_id=${tenantId}
        AND business_id=${businessId}::uuid ORDER BY event_no`)
    ).map((r) => r.state);
  const exitRowOf = async (businessId: string) =>
    (
      await q<Record<string, unknown>>(sql`SELECT mode, initiator, pre_release_date::text AS "preReleaseDate",
        exit_type_code AS "exitTypeCode", supersedes_business_id AS "supersedes"
        FROM exit_requests WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`)
    )[0];
  const timelineOf = (employeeId: string) =>
    q<{ startDate: string; validDuring: string }>(sql`SELECT start_date::text AS "startDate",
      valid_during::text AS "validDuring" FROM employment_timeline
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY start_date, sort_order`);
  const auditCount = async (action: string) =>
    Number(
      (
        await q<{ n: string }>(sql`SELECT count(*) AS n FROM audit_events WHERE tenant_id=${tenantId}
        AND action=${action}`)
      )[0]!.n,
    );
  /** 零写入断言用：人员、业务、离职扩展行的总数。 */
  const writeCounts = async () =>
    (
      await q<{ e: string; b: string; x: string }>(sql`SELECT
        (SELECT count(*) FROM employment_employees WHERE tenant_id=${tenantId}) AS e,
        (SELECT count(*) FROM employment_business_objects WHERE tenant_id=${tenantId}) AS b,
        (SELECT count(*) FROM exit_requests WHERE tenant_id=${tenantId}) AS x`)
    )[0]!;
  const disable = (orgId: string, from: string) => forceDisableOrg(db, tenantId, orgId, from);
  /** 版本表只增不改（app_owner 无 UPDATE）：追加一条同起点、stop_date = last 的新版本，且没有接续版本（场景 P2）。 */
  const stopAfter = (orgId: string, last: string) =>
    q(sql`INSERT INTO org_versions (id, tenant_id, org_id, version_no, previous_version_id, start_date, stop_date,
        enabled, code, name, short_name, broad_type, established_on, full_name, level)
      SELECT gen_random_uuid(), tenant_id, org_id, version_no + 1, id, start_date, ${last}::date, true,
        code, name, short_name, broad_type, established_on, full_name, level
      FROM org_versions WHERE tenant_id = ${tenantId} AND org_id = ${orgId}::uuid
      ORDER BY start_date DESC, version_no DESC LIMIT 1`);

  async function created(rows: readonly ImportRow[], extra: Record<string, unknown> = {}) {
    const response = await importRows(rows, extra);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as {
      batchId: string;
      rows: { rowNo: number; employeeId: string; hireBusinessId: string; exitBusinessId: string }[];
    };
  }
  const errorOf = async (response: Response) =>
    (
      (await response.json()) as {
        error: { code: string; details?: { reason?: string; rows?: ErrorRow[]; hiddenCount?: number } };
      }
    ).error;
  return {
    ...w,
    tenantId,
    sql,
    dept,
    row,
    preview,
    importRows,
    send,
    q,
    employeeByNo,
    employeeCount,
    businessesOf,
    statesOf,
    exitRowOf,
    timelineOf,
    auditCount,
    writeCounts,
    disable,
    stopAfter,
    created,
    errorOf,
  };
}

export interface ErrorRow {
  rowNo: number;
  errors?: { field?: string; reason: string; message: string; disabledOn?: string }[];
  warnings?: Record<string, unknown>[];
  reason?: string;
}

export type ImportWorld = Awaited<ReturnType<typeof importWorld>>;
