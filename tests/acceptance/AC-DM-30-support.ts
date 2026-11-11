/**
 * F-493 历史离职人员导入验收夹具（docs/08_设计/F-493_历史离职人员导入对齐北森_设计.md §3、§6）。
 * 日期设定：今天 2026-11-05；入职日 H = 2023-03-01，最后工作日 L = 2025-06-30，离职生效日 E = L + 1 = 2025-07-01。
 * 数据全部合成：姓名「合成甲 / 乙」，邮箱 syn.*@example.com；部门编码带 uniqueSuffix。
 * 提交是异步的：POST /exits/import 只回 202，执行器在提交后唤醒；测试用 settle() 等它空闲。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { forceDisableOrg } from './AC-EST-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';
import { grantJobUnit } from './support/job-unit.js';
import { exitImportIdle } from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import type { Db } from '@italent/db';

export const TODAY = '2026-11-05';
export const H = '2023-03-01';
export const L = '2025-06-30';
export const E = '2025-07-01';

/** B～Z 共 25 个键（A 列序号不进报文），全部必填键、值为 string | null（设计 §3.1）。 */
export const COLUMN_KEYS = [
  'name',
  'email',
  'departmentCode',
  'entryDate',
  'positionName',
  'postName',
  'levelName',
  'workDate',
  'place',
  'idNumber',
  'mobilePhone',
  'personalEmail',
  'gender',
  'birthday',
  'nation',
  'politicalStatus',
  'householdAddress',
  'registAddress',
  'school',
  'major',
  'lastWorkDate',
  'exitTypeName',
  'exitReasonName',
  'whereaboutsName',
  'exitNote',
] as const;

export type ImportRow = { rowNo: number } & Record<(typeof COLUMN_KEYS)[number], string | null>;

export interface BatchRow {
  row_no: number;
  status: string;
  errors: { column: string | null; reason: string }[];
  employee_id: string | null;
  exit_business_id: string | null;
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
  /** 一行合法数据：只填必填的 B、C、D、E、V，其余键给 null。 */
  const row = (n: number, departmentCode: string, extra: Partial<Record<keyof ImportRow, string | null>> = {}) =>
    ({
      ...Object.fromEntries(COLUMN_KEYS.map((key) => [key, null])),
      rowNo: n,
      name: n % 2 ? '合成甲' : '合成乙',
      email: `syn.r${n}.${label}@example.com`,
      departmentCode,
      entryDate: H,
      lastWorkDate: L,
      ...extra,
    }) as ImportRow;

  let keyNo = 0;
  const submit = (
    rows: readonly unknown[],
    over: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ) =>
    w.session.request('POST', '/exits/import', {
      body: { fileName: '合成导入.xlsx', rows, ...over },
      idempotencyKey: `dm30-${label}-${keyNo++}-${uniqueSuffix()}`,
      ...options,
    });
  /** 提交并等执行器空闲；返回批次号。 */
  async function imported(rows: readonly unknown[], over: Record<string, unknown> = {}) {
    const response = await submit(rows, over);
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as { batchId: string; status: string; total: number };
    await settle();
    return body.batchId;
  }
  const settle = () => exitImportIdle(db);

  const q = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => rowsOf<T>(await tx.execute(statement)));
  const batchOf = async (batchId: string) =>
    (
      await q<{
        status: string;
        total: number;
        created_count: number;
        error_row_count: number;
        error_count: number;
        attempts: number;
        last_error: string | null;
        expires_at: string | null;
      }>(sql`SELECT status, total, created_count, error_row_count, error_count, attempts, last_error, expires_at
        FROM exit_import_batches WHERE tenant_id=${tenantId} AND id=${batchId}::uuid`)
    )[0]!;
  const rowsOfBatch = (batchId: string) =>
    q<BatchRow>(sql`SELECT row_no, status, errors, employee_id::text AS employee_id,
      exit_business_id::text AS exit_business_id FROM exit_import_rows
      WHERE tenant_id=${tenantId} AND batch_id=${batchId}::uuid ORDER BY row_no`);
  const batchCount = async () =>
    Number(
      (await q<{ n: string }>(sql`SELECT count(*) AS n FROM exit_import_batches WHERE tenant_id=${tenantId}`))[0]!.n,
    );
  const employeeCount = async () =>
    Number(
      (await q<{ n: string }>(sql`SELECT count(*) AS n FROM employment_employees WHERE tenant_id=${tenantId}`))[0]!.n,
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
        exit_type_code AS "exitTypeCode", reason_code AS "reasonCode", whereabouts_code AS "whereaboutsCode",
        add_to_blacklist AS "addToBlacklist", batch_id::text AS "batchId", supersedes_business_id::text AS supersedes
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
  /** 零写入断言用：批次、人员、业务、离职扩展行的总数。 */
  const writeCounts = async () =>
    (
      await q<{ a: string; e: string; b: string; x: string }>(sql`SELECT
        (SELECT count(*) FROM exit_import_batches WHERE tenant_id=${tenantId}) AS a,
        (SELECT count(*) FROM employment_employees WHERE tenant_id=${tenantId}) AS e,
        (SELECT count(*) FROM employment_business_objects WHERE tenant_id=${tenantId}) AS b,
        (SELECT count(*) FROM exit_requests WHERE tenant_id=${tenantId}) AS x`)
    )[0]!;
  /** 人员档案当前值（personnel_employee_versions 最新一版，列名为 snake_case）。 */
  const profileOf = async (employeeId: string) =>
    (
      await q<Record<string, unknown>>(sql`SELECT * FROM personnel_employee_versions
        WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`)
    )[0]!;
  /** 经职位模块 API 建岗位 / 职位 / 职级（名称供 F、G、H 列按名匹配；同名职位用于歧义场景）。 */
  const jobApi = tenantApi(db, { clock: () => new Date('2026-11-05T01:00:00Z') });
  const jobPost = async (path: string, body: object) => {
    const response = await jobApi.request('POST', `/api/tenant/job/${path}`, {
      user: w.session.user.id,
      tenant: tenantId,
      ifMatch: 0,
      body: { startDate: '2020-01-01', ...body },
    });
    expect(response.status, `${path} ${await response.clone().text()}`).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  };
  /** 修订职务体系对象（生效日 ≥ 当前起点；等于起点即同日修订，产生同起点的新版本）。返回新 revision。 */
  const jobPatch = async (kind: string, id: string, revision: number, body: object) => {
    const response = await jobApi.request('PATCH', `/api/tenant/job/${kind}/${id}`, {
      user: w.session.user.id,
      tenant: tenantId,
      ifMatch: revision,
      body,
    });
    expect(response.status, `${kind} ${await response.clone().text()}`).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  };
  let unit: Promise<string> | undefined;
  async function jobs(orgId: string) {
    // 职级新建需要创建人有职务体系授权管理单元（DEC-339①）；每个世界只补一次
    unit ??= grantJobUnit(
      (method, path, init) => jobApi.request(method, path, { ...init, user: w.session.user.id, tenant: tenantId }),
      w.session.user.id,
      tenantId,
    );
    await unit;
    const post = await jobPost('posts', { name: '合成岗位', code: `P${uniqueSuffix(12)}` });
    const position = await jobPost('positions', {
      name: '合成职位',
      code: `S${uniqueSuffix(12)}`,
      orgId,
      postId: post.id,
      startDate: '2022-01-01', // 部门设立日起（部门 2022-01-01 设立，早于它的职位建不出来）
    });
    const type = await jobPost('level-types', { name: '合成职级体系', code: `T${uniqueSuffix(12)}` });
    const level = await jobPost('levels', {
      name: '合成职级',
      code: `L${uniqueSuffix(12)}`,
      level: 3,
      levelTypeId: type.id,
    });
    return { post, position, level };
  }
  /** 租户级“允许职位重名”打开后，同部门再建一个同名职位（job 模块默认拒绝重名）。 */
  const duplicatePosition = async (orgId: string, postId: string) => {
    const settings = await jobApi.request('PUT', '/api/tenant/job/settings', {
      user: w.session.user.id,
      tenant: tenantId,
      ifMatch: 0,
      body: { allowDuplicatePositionNames: true, adjustEmployeeDirectManager: false, startDate: '2020-01-01' },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    return jobPost('positions', {
      name: '合成职位',
      code: `S${uniqueSuffix(12)}`,
      orgId,
      postId,
      startDate: '2022-01-01',
    });
  };
  const disable = (orgId: string, from: string) => forceDisableOrg(db, tenantId, orgId, from);
  const errorOf = async (response: Response) =>
    ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;
  return {
    ...w,
    db,
    tenantId,
    sql,
    dept,
    row,
    submit,
    imported,
    settle,
    q,
    batchOf,
    rowsOfBatch,
    batchCount,
    employeeCount,
    businessesOf,
    statesOf,
    exitRowOf,
    timelineOf,
    auditCount,
    writeCounts,
    profileOf,
    jobs,
    jobPatch,
    duplicatePosition,
    disable,
    errorOf,
  };
}

export type ImportWorld = Awaited<ReturnType<typeof importWorld>>;
