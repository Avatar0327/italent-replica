import { routeManifest, type Authorizer } from '@italent/api';
import { sql, type Db } from '@italent/db';
import { buttonResource, CONTRACT_BOARD_OBJECT, HR_DASHBOARD_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { componentCsv } from '../../apps/api/src/modules/analytics/component-export.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { CONTRACT_BOARD_BASE, contractKit, managementScope, structureWorld, TODAY } from './AC-HA-13a-support.js';
import { parseCsv } from './AC-HA-roster-support.js';
import { offerWorld } from './AC-OF-BE14a-support.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { checkRequired } from './support/route-policy/required.js';
import { CONTRACT_BOARD as REQUIRED_CONTRACT } from './support/route-policy/required/contract-board.js';
import { HR_DASHBOARD as REQUIRED_DASH } from './support/route-policy/required/hr-dashboard.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const DASH = '/api/tenant/analytics/hr-dashboard/indicators';
const CONTRACT = `${CONTRACT_BOARD_BASE}/components`;
const AS_OF = `asOf=${TODAY}`;
const EMPLOYEE_COLUMNS = ['明细行 ID', '员工 ID'];
const BOARD_CONTRACT_COLUMNS = ['合同记录 ID', '员工 ID', '组织 ID'];
const DASH_EXPORT = `GET ${DASH}/:code/export`;
const CONTRACT_EXPORT = `GET ${CONTRACT}/:code/export`;
const endpoints = new Set([DASH_EXPORT, CONTRACT_EXPORT]);
const recorder = createRecorder();
type Get = (path: string, options?: RequestOptions) => Promise<Response>;
type Item = { id: string; employeeId: string | null; organizationId?: string | null };

async function buildWorld(db: Db, label: string) {
  const w = await structureWorld(db, label);
  const inside = await w.org('甲部门');
  const outside = await w.org('乙部门');
  const a = await w.hire('甲员工', { date: '2020-01-01', department: inside });
  const b = await w.hire('乙员工', { date: '2020-01-01', department: inside });
  const c = await w.hire('丙员工', { date: '2020-01-01', department: outside });
  const k = await contractKit(w);
  const company = await k.master('companies', '合成法人');
  const otherCompany = await k.master('companies', '另一法人');
  const labor = await k.master('types', '劳动合同');
  const multi = await k.master('types', '多点执业协议');
  const sign = (employeeId: string, typeId: string, effectiveDate: string, endDate: string, companyId = company.id) =>
    k.command({
      operation: 'create',
      employeeId,
      fields: { typeId, companyId, effectiveDate, endDate, termType: 'fixed', signingDate: effectiveDate },
    });
  await sign(a.id, multi.id, '2025-01-01', '2026-12-31');
  const current = await sign(a.id, labor.id, '2026-06-01', '2026-10-20');
  const tie = await sign(a.id, multi.id, '2026-06-01', '2026-12-31');
  const single = await sign(b.id, labor.id, '2026-06-02', '2026-12-31');
  const out = await sign(c.id, labor.id, '2026-06-03', '2026-10-22');
  const competing = await sign(b.id, labor.id, '2026-06-02', '2026-12-31', otherCompany.id);
  return {
    w,
    k,
    inside,
    outside,
    a,
    b,
    c,
    company,
    labor,
    current,
    tie,
    single,
    out,
    competing,
  };
}

let x: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  x = await buildWorld(database().db, 'f547-a');
}, 300_000);

afterAll(() => {
  const contract = readFrozenContract();
  expect(contract).toBeDefined();
  const routes = routeManifest(tenantApi(database().db).app).declared;
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  for (const endpoint of endpoints) {
    expect(contract!.routes[endpoint], endpoint).toBeDefined();
    expect(recorder.facts[endpoint]?.outcome, endpoint).toContainEqual({ status: 200, auditAdded: ['export'] });
  }
  expect(
    checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract: contract! }),
  ).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

const get: Get = (path, options) => x.w.call('GET', path, options);
const pathOf = (base: string, code: string, query = AS_OF) => `${base}/${code}/export?${query}`;

async function csv(response: Response, board: string, code: string, asOf = TODAY) {
  expect(response.status, `${board}/${code} 下载必须成功`).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${board}-${code}-${asOf}.csv"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  expect(text).toMatch(/\r\n$/);
  expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  return parseCsv(text);
}

async function detailRows(read: Get, base: string, code: string, query: string) {
  const rows: Item[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await read(`${base}/${code}?${query}&page=${page}&pageSize=1`);
    expect(response.status).toBe(200);
    const { total, items } = (await response.json()) as { total: number; items: Item[] };
    rows.push(...items);
    if (rows.length === total) return rows;
  }
  throw new Error('验收夹具明细超过 10 页');
}

function logs(w: typeof x.w, object: string, code: string) {
  return w.sqlRows<{
    tenant_id: string;
    actor_user_id: string;
    object_type: string;
    object_id: string;
    behavior: string;
    summary: string;
    total_count: number;
    success_count: number;
    failure_count: number;
    result: string;
    attachment: null;
    items: null;
    error_report: null;
    scope_employee_id: null;
    scope_org_id: null;
    source_page: string | null;
    occurred_at: string | Date;
  }>(sql`SELECT * FROM audit_operation_logs
    WHERE tenant_id=${w.tenantId} AND object_type=${object} AND object_id=${code} AND behavior='export'
    ORDER BY id`);
}

function expectLog(row: Awaited<ReturnType<typeof logs>>[number], w: typeof x.w, object: string, code: string) {
  expect(row).toMatchObject({
    tenant_id: w.tenantId,
    actor_user_id: w.who.user,
    object_type: object,
    object_id: code,
    behavior: 'export',
    total_count: 1,
    success_count: 1,
    failure_count: 0,
    result: 'succeeded',
    attachment: null,
    items: null,
    error_report: null,
    scope_employee_id: null,
    scope_org_id: null,
  });
  expect(new Date(row.occurred_at).toISOString()).toBe(`${TODAY}T01:00:00.000Z`);
}

async function recordSuccess(
  endpoint: string,
  response: Response,
  before: Awaited<ReturnType<typeof logs>>,
  after: Awaited<ReturnType<typeof logs>>,
) {
  recorder.recordFact(
    endpoint,
    'outcome',
    await observe(response, {
      audit: { before: before.map(({ behavior }) => behavior), after: after.map(({ behavior }) => behavior) },
    }),
  );
}

it('AC-HA-F547-01/04/06 B48 员工全量按 D 分页顺序，只有固定两列并审计一次', async () => {
  const code = 'regularEmployees';
  const detail = await detailRows(get, DASH, code, AS_OF);
  expect(detail.map(({ id }) => id)).toEqual([x.a.id, x.b.id, x.c.id].sort());
  const before = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  const response = await get(pathOf(DASH, code), { headers: { 'x-source-page': '/hr-dashboard' } });
  expect(await csv(response.clone(), 'hr-dashboard', code)).toEqual([
    EMPLOYEE_COLUMNS,
    ...detail.map(({ id, employeeId }) => [id, employeeId]),
  ]);
  const after = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 1);
  const log = after.find(({ source_page }) => source_page === '/hr-dashboard')!;
  expectLog(log, x.w, HR_DASHBOARD_OBJECT, code);
  expect(log.summary).toBe('导出组件明细：在职员工数（正式）');
  for (const raw of [AS_OF, x.a.id, x.b.id, x.c.id, x.inside.id]) {
    expect(JSON.stringify(log)).not.toContain(raw);
  }
  await recordSuccess(DASH_EXPORT, response, before, after);
});

it('AC-HA-F547-01/04 B48 合同记录、申请、Offer 及部门各用自身的行 ID', async () => {
  const offer = await offerWorld(database().db, 'f547');
  const created = await offer.social();
  const readOffer: Get = (path) => offer.seeder.request('GET', path, { tenant: offer.tenant.id, user: offer.user.id });
  const pending = await x.k.rawRequest(x.a.id, null, {
    operation: 'create',
    status: 'in_review',
    typeId: x.labor.id,
    companyId: x.company.id,
    effectiveDate: '2026-06-01',
  });
  const cases = [
    { code: 'contractExpiring30', label: '合同记录 ID', ids: [x.current.id, x.out.id], read: get },
    { code: 'contractApproving', label: '申请单 ID', ids: [pending], read: get },
    { code: 'offerPending', label: 'Offer ID', ids: [created.id], read: readOffer },
    { code: 'departmentNoHead', label: '部门 ID', ids: [x.inside.id, x.outside.id], read: get },
  ];
  for (const { code, label, ids, read } of cases) {
    const detail = await detailRows(read, DASH, code, AS_OF);
    expect(detail.map(({ id }) => id)).toEqual(ids.sort());
    expect(await csv(await read(pathOf(DASH, code)), 'hr-dashboard', code)).toEqual([
      [label, '员工 ID'],
      ...detail.map(({ id, employeeId }) => [id, employeeId ?? '']),
    ]);
  }
});

it('AC-HA-F547-01/06 B55 签署按组取 D 的代表合同，下载逐行相等并留痕', async () => {
  const code = 'signByCompany';
  const query = `${AS_OF}&group=${x.company.id}`;
  const detail = await detailRows(get, CONTRACT, code, query);
  expect(detail.map(({ id }) => id)).toEqual([[x.current.id, x.tie.id].sort().at(-1), x.single.id, x.out.id].sort());
  const before = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  const response = await get(pathOf(CONTRACT, code, query));
  expect(await csv(response.clone(), 'contract-board', code)).toEqual([
    BOARD_CONTRACT_COLUMNS,
    ...detail.map(({ id, employeeId, organizationId }) => [id, employeeId, organizationId ?? '']),
  ]);
  const after = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 1);
  expectLog(after[0]!, x.w, CONTRACT_BOARD_OBJECT, code);
  expect(JSON.stringify(after)).not.toContain(x.company.id);
  await recordSuccess(CONTRACT_EXPORT, response, before, after);
});

it('AC-HA-F547-02 B55 合同变动叠加日期、法人、类型、期限，导出申请单而非合同记录', async () => {
  const code = 'changeCreate';
  const indefinite = await x.k.rawRequest(x.a.id, null, {
    operation: 'create',
    status: 'effective',
    typeId: x.labor.id,
    companyId: x.company.id,
    effectiveDate: '2026-06-01',
  });
  await x.w.sqlRows(sql`UPDATE contract_requests SET term_type='indefinite', end_date=NULL
    WHERE tenant_id=${x.w.tenantId} AND id=${indefinite}`);
  const query =
    `${AS_OF}&changeFrom=2026-06-01&changeTo=2026-06-02` +
    `&companyId=${x.company.id}&typeId=${x.labor.id}&termType=fixed`;
  const detail = await detailRows(get, CONTRACT, code, query);
  expect(detail.map(({ id }) => id)).toEqual(
    await x.w
      .sqlRows<{ id: string }>(
        sql`SELECT id::text FROM contract_requests
      WHERE tenant_id=${x.w.tenantId} AND result_id IN (${x.current.id}, ${x.single.id}) ORDER BY id`,
      )
      .then((rows) => rows.map(({ id }) => id)),
  );
  expect(detail).toHaveLength(2);
  expect(await csv(await get(pathOf(CONTRACT, code, query)), 'contract-board', code)).toEqual([
    ['申请单 ID', '员工 ID', '组织 ID'],
    ...detail.map(({ id, employeeId, organizationId }) => [id, employeeId, organizationId ?? '']),
  ]);
  const log = (await logs(x.w, CONTRACT_BOARD_OBJECT, code)).at(0)!;
  for (const value of ['2026-06-01', '2026-06-02', x.company.id, x.labor.id, 'fixed', ...detail.map(({ id }) => id)]) {
    expect(JSON.stringify(log)).not.toContain(value);
  }
});

async function expectError(response: Response, status: number, code: string, details?: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(await response.clone().json()).toMatchObject({ error: { code, ...(details ? { details } : {}) } });
}

it('AC-HA-F547-02 B48/B55 默认日期和可选分组沿用详情，拒绝分页和非法查询', async () => {
  const dashCode = 'regularEmployees';
  const contractCode = 'signByCompany';
  const dashboardCsv = await csv(await get(pathOf(DASH, dashCode, '')), 'hr-dashboard', dashCode);
  expect(dashboardCsv).toHaveLength(4);
  const ungrouped = await csv(await get(pathOf(CONTRACT, contractCode, '')), 'contract-board', contractCode);
  expect(ungrouped).toEqual([
    BOARD_CONTRACT_COLUMNS,
    ...(await detailRows(get, CONTRACT, contractCode, AS_OF)).map(({ id, employeeId }) => [id, employeeId, '']),
  ]);
  expect(ungrouped.map(([id]) => id)).toContain(x.competing.id);
  const beforeDash = await logs(x.w, HR_DASHBOARD_OBJECT, dashCode);
  const beforeContracts = await logs(x.w, CONTRACT_BOARD_OBJECT, contractCode);
  for (const [base, code] of [
    [DASH, dashCode],
    [CONTRACT, contractCode],
  ] as const) {
    for (const query of ['page=1', 'pageSize=100', 'unexpected=1', 'asOf=2026-02-30', `${AS_OF}&%61sOf=${TODAY}`]) {
      await expectError(await get(pathOf(base, code, query)), 400, 'VALIDATION_FAILED');
    }
    await expectError(await get(pathOf(base, 'unregistered')), 404, 'NOT_FOUND');
  }
  for (const query of [
    'changeFrom=2026-06-02&changeTo=2026-06-01',
    'companyId=invalid',
    'typeId=invalid',
    'termType=invalid',
    'group=fixed&group=fixed',
  ]) {
    await expectError(await get(pathOf(CONTRACT, contractCode, query)), 400, 'VALIDATION_FAILED');
  }
  await expectError(await get(pathOf(CONTRACT, 'changeCreate', 'group=unexpected')), 400, 'VALIDATION_FAILED');
  expect(await logs(x.w, HR_DASHBOARD_OBJECT, dashCode)).toEqual(beforeDash);
  expect(await logs(x.w, CONTRACT_BOARD_OBJECT, contractCode)).toEqual(beforeContracts);
});

const BOTH_BOARDS = [HR_DASHBOARD_OBJECT, CONTRACT_BOARD_OBJECT];

it('AC-HA-F547-03/06/08 B48/B55 当前对象权、当前范围及租户独立，缩至空范围仍留一次成功日志', async () => {
  const other = await buildWorld(database().db, 'f547-b');
  const grants = new Set<string>(BOTH_BOARDS);
  const scopes = new Map<string, ModuleScope>();
  const authorize: Authorizer = ({ action, resource }) =>
    (action === 'object.view' && resource !== undefined && grants.has(resource)) ||
    (action === 'object.button' && resource === buttonResource(MODULE_OBJECTS.hrRoster.code, 'export', 'list'));
  registerScopeProvider(authorize, {
    scope: async ({ tenantId, objectCode, pageCode, dataSourceCode, asOf }) => {
      expect(tenantId).toBe(x.w.tenantId);
      expect(BOTH_BOARDS).toContain(objectCode);
      expect([pageCode, dataSourceCode]).toEqual([`${objectCode}.list`, `${objectCode}.list`]);
      expect(asOf).toBe(TODAY);
      return scopes.get(objectCode!) ?? EMPTY_SCOPE;
    },
    fields: async () => new Set(),
    authorize: async (request) => authorize(request),
  });
  const api = tenantApi(database().db, { clock: () => new Date(`${TODAY}T01:00:00Z`), authorize });
  const read: Get = (path, options) => api.request('GET', path, { ...x.w.who, ...options });
  const otherRead: Get = (path) => other.w.call('GET', path);
  const cases = [
    {
      object: HR_DASHBOARD_OBJECT,
      endpoint: DASH_EXPORT,
      base: DASH,
      board: 'hr-dashboard',
      code: 'regularEmployees',
      columns: EMPLOYEE_COLUMNS,
      visible: [x.a.id, x.b.id].sort(),
      other: other.a.id,
    },
    {
      object: CONTRACT_BOARD_OBJECT,
      endpoint: CONTRACT_EXPORT,
      base: CONTRACT,
      board: 'contract-board',
      code: '3.1.17',
      columns: BOARD_CONTRACT_COLUMNS,
      visible: [x.current.id],
      other: other.current.id,
    },
  ] as const;
  for (const { object, endpoint, base, board, code, columns, visible, other: otherId } of cases) {
    const historical = '2026-09-27';
    const query = `asOf=${historical}`;
    scopes.set(object, managementScope(x.w.tenantId, [x.inside.id, x.outside.id]));
    expect((await detailRows(otherRead, base, code, query)).map(({ id }) => id)).toContain(otherId);
    expect(await detailRows(read, base, code, query)).toHaveLength(visible.length + 1);
    const download = pathOf(base, code, query);
    const before = await logs(x.w, object, code);
    grants.delete(object);
    const forbidden = await read(download);
    await expectError(forbidden, 403, 'FORBIDDEN');
    recorder.recordFact(endpoint, 'outcome', await observe(forbidden));
    grants.add(object);
    await expectError(await read(download, { user: undefined }), 401, 'UNAUTHENTICATED');
    await expectError(await read(download, { tenant: undefined }), 400, 'TENANT_CONTEXT_REQUIRED');
    await expectError(await read(download, { tenant: other.w.tenantId }), 403, 'TENANT_NOT_MEMBER');
    expect(await logs(x.w, object, code)).toEqual(before);

    scopes.set(object, managementScope(x.w.tenantId, [x.inside.id]));
    const rows = await csv(await read(download), board, code, historical);
    expect(rows[0]).toEqual(columns);
    expect(rows.slice(1).map(([id]) => id)).toEqual(visible);
    expect(JSON.stringify(rows)).not.toContain(otherId);
    scopes.delete(object);
    expect(await csv(await read(download), board, code, historical)).toEqual([columns]);
    const after = await logs(x.w, object, code);
    expect(after).toHaveLength(before.length + 2);
    expect(after.map(({ success_count }) => success_count)).toEqual(Array<number>(after.length).fill(1));
    expect(JSON.stringify(after)).not.toContain(historical);
    expect(JSON.stringify(after)).not.toContain(otherId);
    expect(await logs(other.w, object, code)).toEqual([]);
  }
  grants.clear();
  for (const { base, code } of cases) await expectError(await read(pathOf(base, code)), 403, 'FORBIDDEN');
});

it('AC-HA-F547-04 共用 CSV 中和公式前缀、转义引号与换行并保留空值、零、false 和数组', () => {
  const text = componentCsv(
    [{ key: 'value', label: '值' }],
    [
      ...['=1+1', '+1', '-1', '@SUM(1)', '\t文字', '\r文字', '甲,"乙"\r\n丙', null, '', 0, false, ['甲', '乙']].map(
        (value) => ({ value, omitted: '投影外的业务值' }),
      ),
    ],
  );
  expect(text.startsWith('\uFEFF值\r\n')).toBe(true);
  expect(text).toContain('"甲,""乙""\r\n丙"\r\n');
  expect(parseCsv(text.slice(1))).toEqual([
    ['值'],
    ["'=1+1"],
    ["'+1"],
    ["'-1"],
    ["'@SUM(1)"],
    ["'\t文字"],
    ["'\r文字"],
    ['甲,"乙"\r\n丙'],
    [''],
    [''],
    ['0'],
    ['false'],
    ['["甲","乙"]'],
  ]);
});

it('AC-HA-F547-05 B55 SQL 路径零行及 10,000 行完整，范围内 10,001 行才超限', async () => {
  const code = 'changeCreate';
  const path = pathOf(CONTRACT, code, `${AS_OF}&changeFrom=2026-08-01&changeTo=2026-08-01`);
  const authorize: Authorizer = ({ action, resource }) =>
    action === 'object.view' && resource === CONTRACT_BOARD_OBJECT;
  registerScopeProvider(authorize, {
    scope: async () => managementScope(x.w.tenantId, [x.inside.id]),
    fields: async () => new Set(),
    authorize: async (request) => authorize(request),
  });
  const api = tenantApi(database().db, { authorize });
  const read = () => api.request('GET', path, x.w.who);
  const append = (employeeId: string, count: number) =>
    x.w.sqlRows<{ id: string }>(sql`INSERT INTO contract_requests
        (tenant_id, employee_id, number, type_id, company_id, term_type, effective_date,
         end_date, signing_count, operation, mode, status, created_by)
      SELECT ${x.w.tenantId}, ${employeeId}, 'F547-' || gen_random_uuid(), ${x.labor.id},
        ${x.company.id}, 'fixed', '2026-08-01', '2027-12-31', 1, 'create', 'direct', 'effective', ${x.w.who.user}
      FROM generate_series(1, ${count}::int)
      RETURNING id`);

  const columns = ['申请单 ID', '员工 ID', '组织 ID'];
  const before = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  expect(await csv(await read(), 'contract-board', code)).toEqual([columns]);
  const expected = (await append(x.a.id, 10_000)).map(({ id }) => id).sort();
  await append(x.c.id, 2);
  expect(await csv(await read(), 'contract-board', code)).toEqual([columns, ...expected.map((id) => [id, x.a.id, ''])]);
  const after = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 2);
  await append(x.a.id, 1);
  const overflow = await read();
  await expectError(overflow, 422, 'VALIDATION_FAILED', { reason: 'EXPORT_ROW_LIMIT', limit: 10_000, total: 10_001 });
  expect(await logs(x.w, CONTRACT_BOARD_OBJECT, code)).toEqual(after);
  recorder.recordFact(CONTRACT_EXPORT, 'outcome', await observe(overflow));
});

it('AC-HA-F547-06 同一 CSV 连续下载各记一条，审计存储拒写则返回 JSON 错误', async () => {
  const code = 'noDirectManager';
  const path = pathOf(DASH, code);
  const before = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  const first = await csv(await get(path), 'hr-dashboard', code);
  expect(first.length).toBeGreaterThan(1);
  expect(await csv(await get(path), 'hr-dashboard', code)).toEqual(first);
  const after = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 2);
  for (const row of after) expectLog(row, x.w, HR_DASHBOARD_OBJECT, code);

  // 只在本文件的独立测试库施加表结构约束，租户行的读写仍经 withTenant。
  await x.w.db.execute(sql`ALTER TABLE audit_operation_logs ADD CONSTRAINT test_f547_audit_rejection
    CHECK (behavior <> 'export' OR object_type <> 'TenantBase.HrDashboard') NOT VALID`);
  try {
    await expectError(await get(path), 500, 'INTERNAL_ERROR');
    expect(await logs(x.w, HR_DASHBOARD_OBJECT, code)).toEqual(after);
  } finally {
    await x.w.db.execute(sql`ALTER TABLE audit_operation_logs DROP CONSTRAINT test_f547_audit_rejection`);
  }
});

it('AC-HA-F547-08 必需项守卫识别缺少登记及接到另一看板的具名范围', () => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(tenantApi(database().db).app).declared;
  for (const [endpoint, required, wrongScope] of [
    [DASH_EXPORT, REQUIRED_DASH, 'contractBoard.visibility'],
    [CONTRACT_EXPORT, REQUIRED_CONTRACT, 'hrDashboard.visibility'],
  ] as const) {
    const route = routes.find(({ method, path }) => `${method} ${path}` === endpoint)!;
    const { policy } = route;
    if (policy.kind !== 'object' || !('mode' in policy.scope) || policy.scope.mode !== 'list')
      throw new Error(`${endpoint} 必须按对象和列表范围声明`);
    expect(policy.fields).toMatchObject({ mode: 'fixed', keys: ['file'] });
    expect(checkRequired(required, contract, [route])).toEqual([]);
    expect(checkRequired({}, contract, [route])).toMatchObject([{ code: 'REQUIRED_ENTRY_MISSING' }]);
    const wrong = { ...route, policy: { ...policy, scope: { ...policy.scope, predicate: wrongScope } } };
    expect(checkRequired(required, contract, [wrong])).toMatchObject([{ code: 'REQUIRED_MISSING' }]);
  }
});
