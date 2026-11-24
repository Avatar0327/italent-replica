import { routeManifest, type Authorizer } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  buttonResource,
  HR_PROCESS_DASHBOARD_OBJECT,
  HR_STRUCTURE_OBJECT,
  MODULE_OBJECTS,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { approvalWorld, type InstanceView } from './AC-APV-support.js';
import { managementScope } from './AC-HA-13a-support.js';
import { PROCESS_BASE, type ProcessDetail } from './AC-HA-13c-support.js';
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
import { HR_PROCESS_DASHBOARD as REQUIRED } from './support/route-policy/required/hr-process-dashboard.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const OBJECT = HR_PROCESS_DASHBOARD_OBJECT;
const TODAY = '2026-10-20';
const at = (date: string, hour = '01') => `${date}T${hour}:00:00.000Z`;
const WINDOW = 'asOf=2026-10-19&from=2026-10-05&to=2026-10-13&category=transfer';
const BASE = `${PROCESS_BASE}/components`;
const ENDPOINT = `GET ${BASE}/:code/export`;
const endpoints = new Set([ENDPOINT]);
const recorder = createRecorder();
const TITLE = '=合成,"标题"\r\n第二行';
const NODE = '@合成,"节点"';
const COMMON = ['审批实例 ID', '分组', '系列', '值', '是否命中'];
const LIST = [
  ...COMMON.slice(0, 1),
  '流程实例名称',
  '审批类别',
  '当前节点',
  '当前审批人 ID',
  '审批人状态',
  '部门 ID',
  '直线经理 ID',
  '发起人 ID',
  '发起时间',
  '任务到达时间',
  '业务日期',
  '在途异常类型',
  '等待时间段',
  '审批计数',
  '明细行 ID',
  ...COMMON.slice(1),
];
type World = Awaited<ReturnType<typeof approvalWorld>>;
type Get = (path: string, options?: RequestOptions) => Promise<Response>;
const download = (code: string, query = '') => `${BASE}/${code}/export?${query}`;
const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

async function seedWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  w.setNow(at('2026-09-01'));
  const inside = await w.org('合成甲部');
  const outside = await w.org('合成乙部');
  const manager = await w.person('合成经理', inside);
  await w.publishedProcess({
    nodes: [{ key: 'mgr', name: NODE, approver: { type: 'object_field', value: 'direct_manager' } }],
  });

  async function submit(department: string, start: string, effectiveDate: string, finish?: string) {
    w.setNow(at('2026-09-01'));
    const person = await w.person('合成调动人', department, { directManagerId: manager.employeeId });
    w.setNow(at(start));
    const business = await w.application(
      person.employeeId,
      { departmentId: department === inside ? outside : inside },
      { effectiveDate },
    );
    const view = await w.submit(business);
    const task = w.pending(view)[0]!;
    expect(task.assigneeUserId).toBe(manager.userId);
    if (finish) {
      w.setNow(at(finish, '05'));
      const response = await w.taskAction(manager.userId, task.id, 'approve', view.revision);
      expect((await w.json<InstanceView>(response)).status).toBe('approved');
    }
    return { id: view.id, task: task.id, business: business.id };
  }
  return { w, inside, outside, manager, submit };
}

async function fixture() {
  const f = await seedWorld(database().db, 'f547-b51');
  const pending = await f.submit(f.inside, '2026-10-12', '2026-10-15');
  const outside = await f.submit(f.outside, '2026-10-13', '2026-10-25');
  const onTime = await f.submit(f.inside, '2026-10-05', '2026-10-05', '2026-10-05');
  const late = await f.submit(f.inside, '2026-10-05', '2026-10-06', '2026-10-07');
  // 标题含公式前缀、引号和换行，同时验证 D 和真实 HTTP 文件。
  await withTenant(f.w.db, f.w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE approval_instances SET title=${TITLE}
      WHERE tenant_id=${f.w.tenant.id} AND id=${pending.id}`),
  );
  f.w.setNow(at(TODAY));
  return { ...f, pending, pendingOutside: outside, onTime, late };
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
}, 300_000);

function reader(w: World, user = w.hr.id, authorize?: Authorizer): Get {
  const api = tenantApi(w.db, { clock: () => new Date(at(TODAY)), ...(authorize ? { authorize } : {}) });
  return (path, options) => api.request('GET', path, { ...w.as(user), ...options });
}
const get: Get = (path, options) => f.w.api.request('GET', path, { ...f.w.as(f.w.hr.id), ...options });

async function details(read: Get, code: string, query = '') {
  const items: ProcessDetail['items'] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await f.w.json<ProcessDetail>(await read(`${BASE}/${code}?${query}&page=${page}&pageSize=1`));
    items.push(...body.items);
    if (items.length === body.total) return items;
  }
  throw new Error('验收夹具明细超过 10 页');
}

async function csvText(response: Response, code: string, asOf: string) {
  expect(response.status, `B51 ${code} 下载必须成功`).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename="hr-process-dashboard-${code}-${asOf}.csv"`,
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  expect(text).toMatch(/\r\n$/);
  return text;
}

async function csv(response: Response, code: string, asOf = TODAY) {
  return parseCsv(await csvText(response, code, asOf));
}

async function expectError(response: Response, status: number, code: string, details?: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(await response.clone().json()).toMatchObject({ error: { code, ...(details ? { details } : {}) } });
}

interface ExportLog {
  tenant_id: string;
  actor_user_id: string;
  object_type: string;
  object_id: string;
  behavior: string;
  occurred_at: string | Date;
}

function logs(w: World, code: string) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<ExportLog>(
      await tx.execute(sql`SELECT * FROM audit_operation_logs
      WHERE tenant_id=${w.tenant.id} AND object_type=${OBJECT} AND object_id=${code} AND behavior='export'
      ORDER BY id`),
    ),
  );
}

const commonCells = ({ instanceId, group, series, value, hit }: ProcessDetail['items'][number]) => [
  instanceId ?? '',
  group ?? '',
  series ?? '',
  String(value ?? ''),
  String(hit ?? ''),
];

it('AC-HA-F547-01/06 B51 跨页全量按 D 的顺序和值交付，成功写一条操作日志', async () => {
  const code = 'inFlightCount';
  const items = await details(get, code, WINDOW);
  expect(items.map(({ id }) => id)).toEqual([f.onTime.id, f.late.id, f.pending.id, f.pendingOutside.id].sort());
  const before = await logs(f.w, code);
  const response = await get(download(code, WINDOW), { headers: { 'x-source-page': 'hr-process-dashboard' } });
  expect(await csv(response.clone(), code, '2026-10-19')).toEqual([
    ['明细行 ID', ...COMMON],
    ...items.map((row) => [row.id, ...commonCells(row)]),
  ]);
  const after = await logs(f.w, code);
  expect(after).toHaveLength(before.length + 1);
  const { occurred_at: occurredAt, ...loggedContent } = after[0]!;
  expect(loggedContent).toMatchObject({
    tenant_id: f.w.tenant.id,
    actor_user_id: f.w.hr.id,
    object_type: OBJECT,
    object_id: code,
    behavior: 'export',
    summary: '导出组件明细：在途流程数',
    source_page: 'hr-process-dashboard',
    success_count: 1,
    failure_count: 0,
    total_count: 1,
    attachment: null,
    items: null,
    error_report: null,
    scope_employee_id: null,
    scope_org_id: null,
  });
  expect(new Date(occurredAt).toISOString()).toBe(at(TODAY));
  for (const secret of ['2026-10-19', '2026-10-05', '2026-10-13', 'transfer', ...items.map(({ id }) => id)])
    expect(JSON.stringify(loggedContent)).not.toContain(secret);
  recorder.recordFact(
    ENDPOINT,
    'outcome',
    await observe(response, {
      audit: { before: before.map(({ behavior }) => behavior), after: after.map(({ behavior }) => behavior) },
    }),
  );
});

it('AC-HA-F547-02 B51 按 D 解释组、系列和 hit=false，下载拒绝非法查询', async () => {
  const code = 'inFlightByApprover';
  const query = `${WINDOW}&departmentId=${f.inside}&group=${f.manager.userId}&series=transfer`;
  const items = await details(get, code, query);
  expect(items.map(({ id }) => id)).toEqual([f.pending.id]);
  expect(await csv(await get(download(code, query)), code, '2026-10-19')).toEqual([
    ['明细行 ID', ...COMMON],
    ...items.map((row) => [row.id, ...commonCells(row)]),
  ]);
  expect(await details(get, code, `${query}&hit=false`)).toEqual([]);
  expect(await csv(await get(download(code, `${query}&hit=false`)), code, '2026-10-19')).toEqual([
    ['明细行 ID', ...COMMON],
  ]);
  const quality = 'nonCompliantByWeek';
  const week = `${WINDOW}&group=2026-10-05&hit=false`;
  expect((await details(get, quality, week)).map(({ id }) => id)).toEqual([f.onTime.id]);
  expect(await csv(await get(download(quality, week)), quality, '2026-10-19')).toEqual([
    ['明细行 ID', ...COMMON],
    [f.onTime.id, f.onTime.id, '2026-10-05', '', '', 'false'],
  ]);
  const before = await logs(f.w, code);
  for (const invalid of [
    'page=1',
    'pageSize=1',
    'unknown=1',
    'hit=0',
    'hit=false&%68it=true',
    'asOf=2026-02-30',
    'from=2026-10-13&to=2026-10-05',
    'category=nope',
    'departmentId=not-a-uuid',
  ])
    await expectError(await get(download(code, invalid)), 400, 'VALIDATION_FAILED');
  expect(await logs(f.w, code)).toEqual(before);
});

function scopedReader(user: string, boardScope: () => ModuleScope, businessScope = () => EMPTY_SCOPE) {
  let view = true;
  let button: 'adminTransfer' | 'adminIntervene' | undefined;
  const authorize: Authorizer = ({ action, resource }) => {
    if (action === 'object.view') return resource === HR_STRUCTURE_OBJECT || (view && resource === OBJECT);
    if (action !== 'object.button') return false;
    return (
      resource === buttonResource(MODULE_OBJECTS.hrRoster.code, 'export', 'list') ||
      (button !== undefined && resource === buttonResource(APPROVAL_INSTANCE_OBJECT, button, 'detail'))
    );
  };
  registerScopeProvider(authorize, {
    scope: async ({ tenantId, objectCode, pageCode, dataSourceCode }) => {
      expect(tenantId).toBe(f.w.tenant.id);
      expect([pageCode, dataSourceCode]).toEqual([`${objectCode}.list`, `${objectCode}.list`]);
      if (objectCode === OBJECT) return boardScope();
      return objectCode === MODULE_OBJECTS.employmentRecord.code ? businessScope() : EMPTY_SCOPE;
    },
    fields: async () => new Set(),
    authorize: async (request) => authorize(request),
  });
  return {
    read: reader(f.w, user, authorize),
    revokeView: () => (view = false),
    setButton: (next?: typeof button) => (button = next),
  };
}

it('AC-HA-F547-03/06 B51 每次读取当前对象权及范围，两租户有同编码数据也独立', async () => {
  const b = await seedWorld(database().db, 'f547-b51-other');
  const other = await b.submit(b.inside, '2026-10-12', '2026-10-15');
  const code = 'inFlightList';
  const query = WINDOW;
  const path = download(code, query);
  const otherCsv = await csv(await reader(b.w)(path), code, '2026-10-19');
  expect(otherCsv.map(([id]) => id)).toEqual([LIST[0], other.id]);
  let scope = managementScope(f.w.tenant.id, [f.inside, f.outside]);
  const revoked = scopedReader(f.w.hr.id, () => scope);
  expect((await details(revoked.read, code, query)).map(({ id }) => id)).toEqual(
    [f.pending.id, f.pendingOutside.id].sort(),
  );
  const before = await logs(f.w, code);
  revoked.revokeView();
  const denied = await revoked.read(path);
  await expectError(denied, 403, 'FORBIDDEN');
  recorder.recordFact(ENDPOINT, 'outcome', await observe(denied));
  const { read } = scopedReader(f.w.hr.id, () => scope);
  await expectError(await read(path, { tenant: undefined }), 400, 'TENANT_CONTEXT_REQUIRED');
  await expectError(await read(path, { tenant: b.w.tenant.id }), 403, 'TENANT_NOT_MEMBER');
  await expectError(await read(path, { user: undefined }), 401, 'UNAUTHENTICATED');
  expect(await logs(f.w, code)).toEqual(before);

  scope = managementScope(f.w.tenant.id, [f.inside]);
  const rows = await csv(await read(path), code, '2026-10-19');
  expect(rows.map(([id]) => id)).toEqual([LIST[0], f.pending.id]);
  expect(JSON.stringify(rows)).not.toContain(other.id);
  scope = EMPTY_SCOPE;
  expect(await csv(await read(path), code, '2026-10-19')).toEqual([LIST]);
  const after = await logs(f.w, code);
  expect(after).toHaveLength(before.length + 2);
  expect(after.every((log) => log.tenant_id === f.w.tenant.id && log.actor_user_id === f.w.hr.id)).toBe(true);
  expect(JSON.stringify(after)).not.toContain(other.id);
  expect(await logs(b.w, code)).toMatchObject([{ tenant_id: b.w.tenant.id, actor_user_id: b.w.hr.id }]);
});

it('AC-HA-F547-04 B51 在途明细按固定顺序投影，真实标题和节点转义并中和公式', async () => {
  const code = 'inFlightList';
  const query = `${WINDOW}&departmentId=${f.inside}`;
  const [row] = await details(get, code, query);
  expect(row).toEqual({
    id: f.pending.id,
    instanceId: f.pending.id,
    title: TITLE,
    category: 'transfer',
    currentNode: NODE,
    currentApproverUserId: f.manager.userId,
    approverStatus: 'active',
    departmentId: f.inside,
    directManagerId: f.manager.employeeId,
    initiatorUserId: f.w.hr.id,
    startedAt: at('2026-10-12'),
    arrivedAt: at('2026-10-12'),
    businessDate: '2026-10-15',
    abnormalTypes: ['expired'],
    waitBucket: 'gt3',
    approvedCount: 0,
    group: null,
    series: null,
    value: null,
    hit: null,
  });
  const text = await csvText(await get(download(code, query)), code, '2026-10-19');
  expect(text).toContain(`"'=合成,""标题""\r\n第二行"`);
  expect(text).toContain(`"'@合成,""节点"""`);
  expect(parseCsv(text)).toEqual([
    LIST,
    [
      f.pending.id,
      `'${TITLE}`,
      'transfer',
      `'${NODE}`,
      f.manager.userId,
      'active',
      f.inside,
      f.manager.employeeId,
      f.w.hr.id,
      at('2026-10-12'),
      at('2026-10-12'),
      '2026-10-15',
      '["expired"]',
      'gt3',
      '0',
      f.pending.id,
      '',
      '',
      '',
      '',
    ],
  ]);
});

it('AC-HA-F547-04 B51 看全部仍需审批披露，两个管理员按钮各自结合业务范围，撤权只裁实例 ID', async () => {
  const stranger = await f.w.member('没有审批参与关系的合成成员');
  const all = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
  let businessScope = EMPTY_SCOPE;
  const { read, setButton } = scopedReader(
    stranger,
    () => all,
    () => businessScope,
  );
  const instanceCode = 'inFlightList';
  const businessCode = 'transferApprovalRate';
  const query = `${WINDOW}&hit=true`;
  const columns = ['业务单 ID', ...COMMON];
  const empty = () => csvFrom(read, instanceCode, WINDOW);
  expect(await empty()).toEqual([LIST]);
  const without = await details(read, businessCode, query);
  expect(without.map(({ id }) => id)).toEqual([f.onTime.business, f.late.business].sort());
  expect(without.every((row) => row.instanceId === null && row.hit === true)).toBe(true);
  const denied = [columns, ...without.map((row) => [row.id, ...commonCells(row)])];
  expect(await csvFrom(read, businessCode, query)).toEqual(denied);

  for (const button of ['adminTransfer', 'adminIntervene'] as const) {
    setButton(button);
    expect(await empty()).toEqual([LIST]);
    businessScope = managementScope(f.w.tenant.id, [f.inside]);
    expect((await empty()).map(([id]) => id)).toEqual([LIST[0], f.pending.id]);
    businessScope = managementScope(f.w.tenant.id, [f.inside, f.outside]);
    const permitted = await details(read, businessCode, query);
    expect(permitted.map(({ id, instanceId }) => [id, instanceId])).toEqual(
      [
        [f.onTime.business, f.onTime.id],
        [f.late.business, f.late.id],
      ].sort(),
    );
    expect(await csvFrom(read, businessCode, query)).toEqual([
      columns,
      ...permitted.map((row) => [row.id, ...commonCells(row)]),
    ]);
    setButton();
    expect(await csvFrom(read, businessCode, query)).toEqual(denied);
    businessScope = EMPTY_SCOPE;
  }
});

async function csvFrom(read: Get, code: string, query: string) {
  return csv(await read(download(code, query)), code, '2026-10-19');
}

it('AC-HA-F547-06 B51 重复成功各记一次，审计存储失败无附件和成功日志', async () => {
  const code = 'inFlightWaiting';
  const path = download(code);
  const before = await logs(f.w, code);
  const first = await csv(await get(path), code);
  expect(first.length).toBeGreaterThan(1);
  const second = await csv(await get(path), code);
  expect(second).toEqual(first);
  const after = await logs(f.w, code);
  expect(after).toHaveLength(before.length + 2);
  await f.w.db.execute(sql`ALTER TABLE audit_operation_logs ADD CONSTRAINT test_f547_b51_audit_rejection
    CHECK (behavior <> 'export' OR object_type <> 'TenantBase.HrProcessDashboard') NOT VALID`);
  try {
    await expectError(await get(path), 500, 'INTERNAL_ERROR');
    expect(await logs(f.w, code)).toEqual(after);
  } finally {
    await f.w.db.execute(sql`ALTER TABLE audit_operation_logs DROP CONSTRAINT test_f547_b51_audit_rejection`);
  }
});

it('AC-HA-F547-02/07 B51 任务按节点导出，未知组件和 7.2.15 占位无文件无成功日志', async () => {
  const code = 'lateApprovalByApprover';
  expect((await details(get, code, WINDOW)).map(({ id }) => id)).toEqual([f.late.task]);
  const taskCode = 'taskDurationByNode';
  const query = `${WINDOW}&group=${encodeURIComponent(NODE)}`;
  const tasks = await details(get, taskCode, query);
  expect(tasks.map(({ id }) => id)).toEqual([f.onTime.task, f.late.task].sort());
  expect(tasks.find(({ id }) => id === f.onTime.task)?.value).toBeCloseTo(4 / 24);
  expect(tasks.find(({ id }) => id === f.late.task)?.value).toBeCloseTo(2 + 4 / 24);
  expect(await csvFrom(get, taskCode, query)).toEqual([
    ['任务 ID', ...COMMON],
    ...tasks.map((task) => [task.id, task.instanceId, `'${NODE}`, '', String(task.value), '']),
  ]);
  for (const unavailable of ['unknown', code]) {
    const before = await logs(f.w, unavailable);
    await expectError(await get(download(unavailable)), 404, 'NOT_FOUND');
    expect(await logs(f.w, unavailable)).toEqual(before);
  }
});

it('AC-HA-F547-06 B51 过限拒绝文件并且不留成功日志', async () => {
  const code = 'inFlightCount';
  const tenant = f.w.tenant.id;
  await withTenant(f.w.db, tenant, (tx) =>
    tx.execute(sql`INSERT INTO approval_instances (
        tenant_id, process_id, version_id, approval_type, object_code, business_type, business_id,
        subject_employee_id, initiator_user_id, title, approval_category, business_date, created_at
      )
      SELECT i.tenant_id, i.process_id, i.version_id, i.approval_type, i.object_code, i.business_type,
        gen_random_uuid(), i.subject_employee_id, i.initiator_user_id, '合成超限流程',
        i.approval_category, i.business_date, '2026-10-18T01:00:00.000Z'::timestamptz
      FROM approval_instances i CROSS JOIN generate_series(1, 10001)
      WHERE i.tenant_id=${tenant} AND i.id=${f.pending.id}`),
  );
  const before = await logs(f.w, code);
  const response = await get(download(code, 'from=2026-10-18&to=2026-10-18'));
  await expectError(response, 422, 'VALIDATION_FAILED', { reason: 'EXPORT_ROW_LIMIT', limit: 10_000, total: 10_001 });
  expect(await logs(f.w, code)).toEqual(before);
  recorder.recordFact(ENDPOINT, 'outcome', await observe(response));
}, 120_000);

it('AC-HA-F547-08 B51 必需项守卫识别漏登记、错接范围及遗漏任一审批披露分支', () => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(f.w.api.app).declared;
  const route = routes.find(({ method, path }) => `${method} ${path}` === ENDPOINT)!;
  const { policy } = route;
  if (policy.kind !== 'object' || !('mode' in policy.scope) || policy.scope.mode !== 'list')
    throw new Error(`${ENDPOINT} 必须按对象和列表范围声明`);
  expect(policy.fields).toMatchObject({ mode: 'fixed', keys: ['file'] });
  expect(checkRequired(REQUIRED, contract, [route])).toEqual([]);
  expect(checkRequired({}, contract, [route])).toMatchObject([{ code: 'REQUIRED_ENTRY_MISSING' }]);
  const wrong = { ...route, policy: { ...policy, scope: { ...policy.scope, predicate: 'hrMovement.visibility' } } };
  expect(checkRequired(REQUIRED, contract, [wrong])).toMatchObject([{ code: 'REQUIRED_MISSING' }]);
  for (const missing of ['adminTransfer', 'adminIntervene']) {
    const optional = Object.fromEntries(Object.entries(policy.optional ?? {}).filter(([key]) => key !== missing));
    const stripped = { ...route, policy: { ...policy, optional } };
    expect(checkRequired(REQUIRED, contract, [stripped])).toMatchObject([{ code: 'DISCLOSURE_MISSING' }]);
  }
});

afterAll(() => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(tenantApi(database().db).app).declared;
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  expect(recorder.facts[ENDPOINT]?.outcome).toEqual(
    expect.arrayContaining([
      { status: 200, auditAdded: ['export'] },
      { status: 403, code: 'FORBIDDEN' },
      { status: 422, code: 'VALIDATION_FAILED', reason: 'EXPORT_ROW_LIMIT' },
    ]),
  );
  expect(checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract })).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});
