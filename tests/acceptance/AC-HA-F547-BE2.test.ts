import { routeManifest, type Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { buttonResource, HR_MOVEMENT_OBJECT, HR_STRUCTURE_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/read-model.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  boardClient,
  CONTRACT_BOARD_BASE,
  managementScope,
  STRUCTURE_BASE,
  structureWorld,
  TODAY,
  type DetailPage,
} from './AC-HA-13a-support.js';
import { groupKey, MOVEMENT_BASE, MOVEMENT_TODAY, movementClient, movementWorld } from './AC-HA-13b-support.js';
import { parseCsv } from './AC-HA-roster-support.js';
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
import { HR_MOVEMENT as REQUIRED_MOVEMENT } from './support/route-policy/required/hr-movement.js';
import { HR_STRUCTURE as REQUIRED_STRUCTURE } from './support/route-policy/required/hr-structure.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const structure = { base: STRUCTURE_BASE, name: 'hr-structure', object: HR_STRUCTURE_OBJECT, asOf: TODAY };
const movement = { base: MOVEMENT_BASE, name: 'hr-movement', object: HR_MOVEMENT_OBJECT, asOf: MOVEMENT_TODAY };
const COLUMNS = ['明细行 ID', '员工 ID', '组织 ID'];
type Board = typeof structure | typeof movement;
type Read = (path: string, options?: RequestOptions) => Promise<Response>;
type Who = { tenant: string; user: string };
const endpoint = ({ base }: Board) => `GET ${base}/components/:code/export`;
const endpoints = new Set([endpoint(structure), endpoint(movement)]);
const recorder = createRecorder();

async function structureFixture() {
  const w = await structureWorld(database().db, 'f547-be2');
  const parent = await w.org('甲机构', undefined, '机构');
  const child = await w.org('乙机构', parent, '机构');
  const team = await w.org('甲小组', parent);
  const outside = await w.org('范围外机构', undefined, '机构');
  const hire = (name: string, department: { id: string }, educationLevel: string) =>
    w.hire(name, { date: '2026-01-01', department, profile: { educationLevel } });
  const bachelor = await hire('合成本科', parent, '本科');
  const master = await hire('合成硕士', parent, '硕士');
  const junior = await hire('合成专科', parent, '大专');
  const teamMember = await hire('合成组员', team, '本科');
  const childMember = await hire('合成子机构人员', child, '本科');
  const outsideMember = await hire('合成范围外人员', outside, '本科');
  return { w, parent, child, team, outside, bachelor, master, junior, teamMember, childMember, outsideMember };
}

let s: Awaited<ReturnType<typeof structureFixture>>;
let m: Awaited<ReturnType<typeof movementWorld>>;
beforeAll(async () => {
  s = await structureFixture();
  m = await movementWorld(database().db);
}, 600_000);

const readStructure: Read = (path, options) => s.w.call('GET', path, options);
const readMovement: Read = (path, options) => m.call('GET', path, options);
const detailPath = (board: Board, component: string) => `${board.base}/components/${component}`;
const date = (board: Board) => `asOf=${board.asOf}`;
const group = (key: string) => `group=${encodeURIComponent(key)}`;
const download = (board: Board, component: string, query = date(board)) =>
  `${detailPath(board, component)}/export?${query}`;

afterAll(() => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(tenantApi(database().db).app).declared;
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  for (const key of endpoints) {
    expect(contract.routes[key], key).toBeDefined();
    expect(recorder.facts[key]?.outcome, key).toContainEqual({ status: 200, auditAdded: ['export'] });
    expect(recorder.facts[key]?.outcome, key).toContainEqual({ status: 403, code: 'FORBIDDEN' });
  }
  expect(checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract })).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

async function csv(response: Response, board: Board, code: string, asOf: string = board.asOf) {
  expect(response.status, `${board.name}/${code} 下载必须成功`).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${board.name}-${code}-${asOf}.csv"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const body = new TextDecoder().decode(bytes.slice(3));
  expect(body).toMatch(/\r\n$/);
  expect(body.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  return parseCsv(body);
}

async function detailRows(read: Read, board: Board, code: string, query: string) {
  const result: DetailPage['items'] = [];
  for (let page = 1; page <= 15; page++) {
    const response = await read(`${detailPath(board, code)}?${query}&page=${page}&pageSize=1`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { total, items } = (await response.json()) as DetailPage;
    result.push(...items);
    if (result.length === total) return result;
  }
  throw new Error('验收夹具明细超过 15 页');
}

function logs(tenantId: string, board: Board, code: string) {
  return withTenant(database().db, tenantId, async (tx) =>
    rowsOf<{ id: string; behavior: string; occurred_at: string | Date }>(
      await tx.execute(sql`SELECT * FROM audit_operation_logs
        WHERE tenant_id=${tenantId} AND object_type=${board.object} AND object_id=${code} AND behavior='export'
        ORDER BY id`),
    ),
  );
}

async function compareDetail(
  read: Read,
  board: Board,
  code: string,
  query: string,
  expected: readonly { id: string }[],
  options?: RequestOptions,
) {
  const rows = await detailRows(read, board, code, query);
  expect(rows.map(({ id }) => id).sort()).toEqual(expected.map(({ id }) => id).sort());
  const response = await read(download(board, code, query), options);
  expect(await csv(response.clone(), board, code)).toEqual([
    COLUMNS,
    ...rows.map(({ id, employeeId, organizationId }) => [id, employeeId ?? '', organizationId ?? '']),
  ]);
  return response;
}

function expectLog(
  row: Awaited<ReturnType<typeof logs>>[number],
  who: Who,
  board: Board,
  code: string,
  summary: string,
) {
  expect(row).toMatchObject({
    tenant_id: who.tenant,
    actor_user_id: who.user,
    object_type: board.object,
    object_id: code,
    behavior: 'export',
    total_count: 1,
    success_count: 1,
    failure_count: 0,
    result: 'succeeded',
    summary: `导出组件明细：${summary}`,
    source_page: `/${board.name}`,
    attachment: null,
    items: null,
    error_report: null,
    scope_employee_id: null,
    scope_org_id: null,
  });
  expect(new Date(row.occurred_at).toISOString()).toBe(`${board.asOf}T01:00:00.000Z`);
}

async function expectAuditedDownload(
  read: Read,
  board: Board,
  who: Who,
  code: string,
  query: string,
  expected: readonly { id: string }[],
  summary: string,
) {
  const before = await logs(who.tenant, board, code);
  const response = await compareDetail(read, board, code, query, expected, {
    headers: { 'x-source-page': `/${board.name}` },
  });
  const after = await logs(who.tenant, board, code);
  const added = after.filter((row) => !before.some(({ id }) => id === row.id));
  expect(added).toHaveLength(1);
  expectLog(added[0]!, who, board, code, summary);
  const rawValues = [...new URLSearchParams(query)].flatMap(([key, value]) => [
    `${key}=${value}`,
    ...(key === 'group' ? [value] : []),
  ]);
  for (const value of [...rawValues, ...expected.map(({ id }) => id)])
    expect(JSON.stringify(added[0])).not.toContain(value);
  recorder.recordFact(
    endpoint(board),
    'outcome',
    await observe(response, {
      audit: { before: before.map(({ behavior }) => behavior), after: after.map(({ behavior }) => behavior) },
    }),
  );
}

it('AC-HA-F547-01/02/06 B49 两个含下级开关均为 false，6.11 只下载本科及以上分子并留痕', async () => {
  const code = '6.11';
  const filter =
    `${date(structure)}&institutionId=${s.parent.id}&institutionIncludeChildren=false` +
    `&departmentId=${s.parent.id}&departmentIncludeChildren=false`;
  const overview = await boardClient(database().db, s.w.who).component(structure.base, code, filter);
  expect(overview.groups?.find(({ key }) => key === s.parent.id)).toMatchObject({ count: 2, total: 3 });
  await expectAuditedDownload(
    readStructure,
    structure,
    s.w.who,
    code,
    `${filter}&${group(s.parent.id)}`,
    [s.bachelor, s.master],
    '本科及以上学历占比',
  );
});

it('AC-HA-F547-01/02/06 B50 按离职生效月跨分页下载，行顺序与 D 相等并留痕', async () => {
  const code = '6.26';
  const query = `${date(movement)}&${group('exit:2026-04')}`;
  await expectAuditedDownload(readMovement, movement, m.who, code, query, [m.p.m30, m.p.m31], '近 12 月入离职统计');
});

it('AC-HA-F547-02 B49 两个含下级开关独立生效，继续沿用 D 的当前筛选和默认日期', async () => {
  const own = [s.bachelor, s.master, s.junior];
  const filter = `${date(structure)}&institutionId=${s.parent.id}&departmentId=${s.parent.id}`;
  for (const [institutionChildren, deptChildren, expected] of [
    [false, true, [...own, s.teamMember]],
    [true, false, own],
    [true, true, [...own, s.teamMember, s.childMember]],
  ] as const) {
    const query =
      `${filter}&institutionIncludeChildren=${institutionChildren}` + `&departmentIncludeChildren=${deptChildren}`;
    await compareDetail(readStructure, structure, '6.01', query, expected);
  }
  const seq = await s.w.job('sequences', '合成序列');
  const category = await s.w.category('合成人员类别');
  const formReply = await s.w.session.request('GET', '/employment-forms');
  expect(formReply.status).toBe(200);
  const form = ((await formReply.json()) as { items: { code: string }[] }).items[0]!.code;
  const selected = await s.w.hire('筛选命中', {
    date: '2026-01-01',
    department: s.child,
    fields: { sequenceId: seq.id, employmentType: category.id, employmentForm: form },
  });
  await s.w.hire('筛选未命中', { date: '2026-01-01', department: s.child, fields: { sequenceId: seq.id } });
  const query = new URLSearchParams({
    sequenceId: seq.id.toUpperCase(),
    employmentType: '合成人员类别',
    employmentForm: form,
  });
  await compareDetail(readStructure, structure, '6.01', query.toString(), [selected]);
});

it('AC-HA-F547-02 B50 不同月份、双层元组与合法空分组按 D 取行', async () => {
  const { p, T, R, W, A } = m;
  for (const [code, key, expected] of [
    ['6.25', '2026-10', [p.old, p.oct1, p.reg, p.orgAdj]],
    ['6.26', 'exit:2026-02', [p.jan31]],
    ['6.26', 'exit:2026-04', [p.m30]],
    ['6.28', '2026-10', []],
    ['6.29', groupKey('leave', T.vol), [p.jan31, p.m30]],
    ['6.29', groupKey('leave', T.vol, R.dev), [p.m30]],
    ['6.30', groupKey('leave', T.vol, W.peer), [p.jan31]],
    ['6.30', groupKey('leave', T.vol, null), [p.m30]],
  ] as const) {
    const query = `${date(movement)}&departmentId=${A.id}&${group(key)}`;
    await compareDetail(readMovement, movement, code, query, expected);
  }
});

it('AC-HA-F547-02 B50 3.1.36 以编制对象键取部门及下级的实有人员', async () => {
  const G = await m.org('合成编制部门');
  const G1 = await m.org('合成编制小组', G);
  const parentStaff = await m.hire('编制部门员工', '2026-02-01', G);
  const childStaff = await m.hire('编制小组员工', '2026-02-01', G1);
  async function create(path: string, body: Record<string, unknown>) {
    const response = await m.call('POST', `/api/tenant/establishment/${path}`, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const schemeId = await create('schemes', {
    name: '合成编制方案',
    periodType: 'annual',
    startMonth: 1,
    maintenanceMode: 'local',
    subdivision: 'none',
    startDate: '2026-01-01',
  });
  const cap = await create('capacities', {
    orgId: G.id,
    schemeId,
    periodStart: '2026-01-01',
    localCapacity: 10,
    strictControl: false,
  });
  const code = '3.1.36';
  const filter = `${date(movement)}&departmentId=${G.id}`;
  expect(await movementClient(m.db, m.who).group(code, filter, cap)).toMatchObject({ count: 2, key: cap });
  await compareDetail(readMovement, movement, code, `${filter}&${group(cap.toUpperCase())}`, [parentStaff, childStaff]);
  await compareDetail(readMovement, movement, code, `${filter}&${group(G.id)}`, []);
});

async function expectError(response: Response, status: number, code: string, details?: unknown) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(await response.json()).toMatchObject({ error: { code, ...(details ? { details } : {}) } });
}

it('AC-HA-F547-02/06/07 B49/B50 拒绝非法查询和占位组件，错误无附件或成功日志', async () => {
  for (const [board, read, who, code] of [
    [structure, readStructure, s.w.who, '6.01'],
    [movement, readMovement, m.who, '6.27'],
  ] as const) {
    const before = await logs(who.tenant, board, code);
    for (const query of [
      'page=1',
      'pageSize=100',
      'unknown=1',
      'asOf=2026-02-30',
      'departmentId=invalid',
      `${date(board)}&%61sOf=${board.asOf}`,
    ]) {
      await expectError(await read(download(board, code, query)), 400, 'VALIDATION_FAILED');
    }
    await expectError(await read(download(board, 'unregistered')), 404, 'NOT_FOUND');
    expect(await logs(who.tenant, board, code)).toEqual(before);
    expect(await logs(who.tenant, board, 'unregistered')).toEqual([]);
  }
  for (const query of ['departmentIncludeChildren=0', 'institutionIncludeChildren=False', 'group=any']) {
    await expectError(await readStructure(download(structure, '6.01', query)), 400, 'VALIDATION_FAILED');
  }
  for (const code of ['6.09', '6.10']) {
    await expectError(await readStructure(download(structure, code)), 404, 'NOT_FOUND');
    expect(await logs(s.w.tenantId, structure, code)).toEqual([]);
  }
  for (const code of ['6.25', '6.26', '6.28', '3.1.36']) {
    const before = await logs(m.tenantId, movement, code);
    await expectError(await readMovement(download(movement, code)), 400, 'VALIDATION_FAILED');
    expect(await logs(m.tenantId, movement, code)).toEqual(before);
  }
  const query = `${date(movement)}&${group(m.A.id)}`;
  expect((await detailRows(readMovement, movement, '6.32', query)).map(({ id }) => id)).toEqual([m.p.m30.id]);
  await expectError(await readMovement(download(movement, '6.32', query)), 404, 'NOT_FOUND');
  expect(await logs(m.tenantId, movement, '6.32')).toEqual([]);
});

function controlledRead(
  who: Who,
  grants: Set<string>,
  scopes: ReadonlyMap<string, ModuleScope>,
  rosterExport = false,
): Read {
  const authorize: Authorizer = ({ action, resource }) =>
    (action === 'object.view' && resource !== undefined && grants.has(resource)) ||
    (rosterExport &&
      action === 'object.button' &&
      resource === buttonResource(MODULE_OBJECTS.hrRoster.code, 'export', 'list'));
  registerScopeProvider(authorize, {
    scope: async ({ tenantId, objectCode, pageCode, dataSourceCode }) => {
      expect(tenantId).toBe(who.tenant);
      expect(grants.has(objectCode!)).toBe(true);
      expect([pageCode, dataSourceCode]).toEqual([`${objectCode}.list`, `${objectCode}.list`]);
      return scopes.get(objectCode!) ?? EMPTY_SCOPE;
    },
    fields: async () => new Set(),
    authorize: async (request) => authorize(request),
  });
  const api = tenantApi(database().db, { authorize, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  return (path, options) => api.request('GET', path, { ...who, ...options });
}

it('AC-HA-F547-03 只授 B49 可下载 B49，其他看板与仅持名册导出按钮均无权', async () => {
  const grants = new Set<string>([structure.object]);
  const scopes = new Map([[structure.object, managementScope(s.w.tenantId, [s.parent.id])]]);
  const read = controlledRead(s.w.who, grants, scopes, true);
  const code = '6.01';
  await compareDetail(read, structure, code, date(structure), [s.bachelor, s.master, s.junior]);
  const otherPaths = [
    download(movement, '6.25', `${date(movement)}&${group('2026-10')}`),
    `/api/tenant/analytics/hr-dashboard/indicators/regularEmployees/export?${date(structure)}`,
    `${CONTRACT_BOARD_BASE}/components/3.1.17/export?${date(structure)}`,
  ];
  for (const path of otherPaths) await expectError(await read(path), 403, 'FORBIDDEN');
  grants.clear();
  const before = await logs(s.w.tenantId, structure, code);
  for (const path of [download(structure, code), ...otherPaths]) {
    await expectError(await read(path), 403, 'FORBIDDEN');
  }
  expect(await logs(s.w.tenantId, structure, code)).toEqual(before);
});

it('AC-HA-F547-03/06/08 B49/B50 按当前对象权和范围重新取数，隔离异租户同编码人员', async () => {
  const foreign = await structureWorld(database().db, 'f547-be2-foreign');
  const foreignOrg = await foreign.org('合成其他租户部门');
  const foreignStaff = [];
  for (const code of [s.bachelor.code, m.p.old.code]) {
    const e = await foreign.session.employee('合成同编码员工', code);
    expect(e.code).toBe(code);
    await foreign.session.business(
      e.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { employType: 'internal', departmentId: foreignOrg.id },
      },
      e.revision,
    );
    foreignStaff.push(e);
  }

  const asOf = '2026-09-29';
  for (const [board, who, code, key, narrowOrg, extraOrg, narrow, extra] of [
    [structure, s.w.who, '6.01', '', s.parent.id, s.outside.id, [s.bachelor, s.master, s.junior], s.outsideMember],
    [movement, m.who, '6.25', '2026-09', m.A1.id, m.from.id, [m.p.old, m.p.reg, m.p.orgAdj], m.p.base],
  ] as const) {
    const query = `asOf=${asOf}${key ? `&${group(key)}` : ''}`;
    const foreignRead: Read = (path) => foreign.call('GET', path);
    expect((await detailRows(foreignRead, board, code, query)).map(({ id }) => id).sort()).toEqual(
      foreignStaff.map(({ id }) => id).sort(),
    );
    const grants = new Set<string>([board.object]);
    const scopes = new Map([[board.object, managementScope(who.tenant, [narrowOrg, extraOrg])]]);
    const read = controlledRead(who, grants, scopes);
    const path = download(board, code, query);
    expect((await detailRows(read, board, code, query)).map(({ id }) => id).sort()).toEqual(
      [...narrow, extra].map(({ id }) => id).sort(),
    );

    const before = await logs(who.tenant, board, code);
    grants.clear();
    const denied = await read(path);
    await expectError(denied.clone(), 403, 'FORBIDDEN');
    recorder.recordFact(endpoint(board), 'outcome', await observe(denied));
    grants.add(board.object);
    await expectError(await read(path, { user: undefined }), 401, 'UNAUTHENTICATED');
    await expectError(await read(path, { tenant: undefined }), 400, 'TENANT_CONTEXT_REQUIRED');
    await expectError(await read(path, { tenant: foreign.tenantId }), 403, 'TENANT_NOT_MEMBER');
    expect(await logs(who.tenant, board, code)).toEqual(before);

    scopes.set(board.object, managementScope(who.tenant, [narrowOrg]));
    const visible = (await csv(await read(path), board, code, asOf)).slice(1);
    expect(visible.map(([id]) => id).sort()).toEqual(narrow.map(({ id }) => id).sort());
    expect(visible.every(([, , org]) => org === narrowOrg)).toBe(true);
    scopes.clear();
    expect(await csv(await read(path), board, code, asOf)).toEqual([COLUMNS]);
    const after = await logs(who.tenant, board, code);
    expect(after).toHaveLength(before.length + 2);
    const newLogs = after.filter(({ id }) => !before.some((previous) => previous.id === id));
    expect(newLogs).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ success_count: 1 })));
    for (const value of [asOf, narrowOrg, extra.id, ...foreignStaff.map(({ id }) => id)]) {
      expect(JSON.stringify(newLogs)).not.toContain(value);
    }
    expect(await logs(foreign.tenantId, board, code)).toEqual([]);
  }
});

it('AC-HA-F547-06 B49/B50 重复下载各留痕，审计存储拒绝则无文件', async () => {
  const cases = [
    { board: structure, who: s.w.who, read: readStructure, code: '6.01' },
    { board: movement, who: m.who, read: readMovement, code: '6.27' },
  ] as const;
  const counts = new Map<Board, Awaited<ReturnType<typeof logs>>>();
  for (const { board, who, read, code } of cases) {
    const path = download(board, code);
    const before = await logs(who.tenant, board, code);
    const first = await csv(await read(path), board, code);
    expect(first.length).toBeGreaterThan(1);
    expect(await csv(await read(path), board, code)).toEqual(first);
    const after = await logs(who.tenant, board, code);
    expect(after).toHaveLength(before.length + 2);
    counts.set(board, after);
  }
  // 只给本文件独立库施加审计写入故障，租户数据仍经 withTenant 读写。
  const { db } = database();
  await db.execute(sql`ALTER TABLE audit_operation_logs ADD CONSTRAINT test_f547_be2_audit_rejection
    CHECK (behavior <> 'export' OR object_type NOT IN ('TenantBase.HrStructure', 'TenantBase.HrMovement')) NOT VALID`);
  try {
    for (const { board, who, read, code } of cases) {
      await expectError(await read(download(board, code)), 500, 'INTERNAL_ERROR');
      expect(await logs(who.tenant, board, code)).toEqual(counts.get(board));
    }
  } finally {
    await db.execute(sql`ALTER TABLE audit_operation_logs DROP CONSTRAINT test_f547_be2_audit_rejection`);
  }
});

it('AC-HA-F547-08 必需项守卫识别两个路由漏登记或接错具名范围', () => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(tenantApi(database().db).app).declared;
  for (const [board, required, wrongScope] of [
    [structure, REQUIRED_STRUCTURE, 'hrMovement.visibility'],
    [movement, REQUIRED_MOVEMENT, 'hrStructure.visibility'],
  ] as const) {
    const key = endpoint(board);
    const route = routes.find(({ method, path }) => `${method} ${path}` === key)!;
    const { policy } = route;
    if (policy.kind !== 'object' || !('mode' in policy.scope) || policy.scope.mode !== 'list')
      throw new Error(`${key} 必须按对象和列表范围声明`);
    expect(policy.fields).toMatchObject({ mode: 'fixed', keys: ['file'] });
    expect(checkRequired(required, contract, [route])).toEqual([]);
    expect(checkRequired({}, contract, [route])).toMatchObject([{ code: 'REQUIRED_ENTRY_MISSING' }]);
    const wrong = { ...route, policy: { ...policy, scope: { ...policy.scope, predicate: wrongScope } } };
    expect(checkRequired(required, contract, [wrong])).toMatchObject([{ code: 'REQUIRED_MISSING' }]);
  }
});

async function appendEmployees(tenantId: string, template: string, count: number) {
  // 沿用 AC-EMP-16 万人造数的版本链结构，正常入职记录作为模板。
  return withTenant(database().db, tenantId, async (tx) => {
    // 批量造数前表统计还是小样本，提交时的版本链约束按索引核对，避免在这里反复扫描整表。
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`DISCARD PLANS`);
    await tx.execute(sql`CREATE TEMP TABLE f547_be2_employees ON COMMIT DROP AS SELECT
      gen_random_uuid() AS employee_id, gen_random_uuid() AS staff_id, gen_random_uuid() AS business_id,
      gen_random_uuid() AS payload_id FROM generate_series(1, ${count}::int)`);
    const result = await tx.execute(sql`INSERT INTO employment_employees(tenant_id,id,name,code)
      SELECT ${tenantId}, employee_id, '合成导出员工', 'F547BE2-'||employee_id FROM f547_be2_employees RETURNING id`);
    await tx.execute(sql`INSERT INTO employment_cycles SELECT (jsonb_populate_record(NULL::employment_cycles,
      to_jsonb(c)||jsonb_build_object('id',m.staff_id,'employee_id',m.employee_id))).*
      FROM employment_cycles c CROSS JOIN f547_be2_employees m
      WHERE c.tenant_id=${tenantId} AND c.employee_id=${template}::uuid`);
    await tx.execute(sql`INSERT INTO employment_business_objects(tenant_id,id,employee_id)
      SELECT ${tenantId},business_id,employee_id FROM f547_be2_employees`);
    await tx.execute(sql`INSERT INTO employment_payload_versions
      SELECT (jsonb_populate_record(NULL::employment_payload_versions,to_jsonb(p)||jsonb_build_object(
        'id',m.payload_id,'employee_id',m.employee_id,'business_id',m.business_id,
        'version_no',1,'previous_version_id',NULL))).*
      FROM (SELECT * FROM employment_payload_versions WHERE tenant_id=${tenantId} AND employee_id=${template}::uuid
        ORDER BY version_no DESC LIMIT 1) p CROSS JOIN f547_be2_employees m`);
    await tx.execute(sql`INSERT INTO employment_records SELECT (jsonb_populate_record(NULL::employment_records,
      to_jsonb(r)||jsonb_build_object('id',m.business_id,'employee_id',m.employee_id,
        'staff_id',m.staff_id,'payload_version_id',m.payload_id))).*
      FROM employment_records r CROSS JOIN f547_be2_employees m
      WHERE r.tenant_id=${tenantId} AND r.employee_id=${template}::uuid`);
    await tx.execute(sql`INSERT INTO employment_timeline SELECT (jsonb_populate_record(NULL::employment_timeline,
      to_jsonb(t)||jsonb_build_object('record_id',m.business_id,'employee_id',m.employee_id,'staff_id',m.staff_id))).*
      FROM employment_timeline t CROSS JOIN f547_be2_employees m
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${template}::uuid`);
    return rowsOf<{ id: string }>(result).map(({ id }) => id);
  });
}

it('AC-HA-F547-05 B49/B50 成员数组 0、10,000、10,001 行边界只计范围内人员', async () => {
  const w = await structureWorld(database().db, 'f547-be2-bulk');
  const inside = await w.org('合成范围内部门');
  const outside = await w.org('合成范围外部门');
  const excluded = await w.hire('合成范围外员工', { date: TODAY, department: outside });
  const grants = new Set<string>([structure.object, movement.object]);
  const scope: ModuleScope = {
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    orgIds: [inside.id],
    terms: [{ dimension: 'organization', orgIds: [inside.id], personIds: [] }],
  };
  const scopes = new Map([...grants].map((object) => [object, scope]));
  const read = controlledRead(w.who, grants, scopes);
  const cases = [
    { board: structure, code: '6.01', filter: `asOf=${TODAY}` },
    { board: movement, code: '6.25', filter: `asOf=${TODAY}&${group('2026-10')}` },
  ] as const;
  for (const { board, code, filter } of cases) {
    expect(await csv(await read(download(board, code, filter)), board, code, TODAY)).toEqual([COLUMNS]);
    expect(await logs(w.tenantId, board, code)).toHaveLength(1);
  }

  const first = await w.hire('合成范围内模板', { date: TODAY, department: inside });
  const ids = [first.id, ...(await appendEmployees(w.tenantId, first.id, 9_999))].sort();
  await appendEmployees(w.tenantId, excluded.id, 2);
  // 临时库批量写入后更新优化器统计，后面的 HTTP 请求使用正常的查询计划。
  await database().db.execute(sql`ANALYZE employment_records, employment_timeline,
    employment_payload_versions, employment_business_objects`);
  const expected = [COLUMNS, ...ids.map((id) => [id, id, inside.id])];
  for (const { board, code, filter } of cases) {
    expect(await csv(await read(download(board, code, filter)), board, code, TODAY)).toEqual(expected);
    expect(await logs(w.tenantId, board, code)).toHaveLength(2);
  }

  await appendEmployees(w.tenantId, first.id, 1);
  for (const { board, code, filter } of cases) {
    const before = await logs(w.tenantId, board, code);
    const overflow = await read(download(board, code, filter));
    await expectError(overflow.clone(), 422, 'VALIDATION_FAILED', {
      reason: 'EXPORT_ROW_LIMIT',
      limit: 10_000,
      total: 10_001,
    });
    expect(await logs(w.tenantId, board, code)).toEqual(before);
    recorder.recordFact(endpoint(board), 'outcome', await observe(overflow));
  }
}, 300_000);
