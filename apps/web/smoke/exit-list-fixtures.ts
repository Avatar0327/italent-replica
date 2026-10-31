import type { Page, Request, Route } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';
import { presetRows, type Kind } from './exit-fixtures.js';

// 形态对照（FE-R2c2）：列表 = exit-queries.ts ExitItem 经 trimExit 后平铺 + rowActions（exit-routes.ts GET /exits）；
// 详情 = exitDetailPayload（多 dates 与 ExitExtension 字段）；提交前检查 = exit-preview.ts previewExit；
// 交接区 = exit-handover.ts exitHandoverStatus；写回执 = EmploymentBusiness / 业务头（kind: 'leave'）。数据全部为合成值。
// 第 2 轮：新建按 mode（申请 = draft，transitions.ts submit 后 in_review）；撤销 = exit-cancel.ts（在途 / 通过 voided、
// 已生效 deleted，回执带 cancellation + downstream）；改期 = exit-routes.ts PATCH 投影（改了日期才带 downstreamHints）；
// 交接 = exit-handover-routes.ts / exit-handover-batch.ts；所有单据命令按 If-Match 核 revision，不一致回 409。
export const department = '61000000-0000-4000-8000-000000000001';
export const ids = {
  inProgress: '71000000-0000-4000-8000-000000000001',
  completed: '71000000-0000-4000-8000-000000000002',
  failed: '71000000-0000-4000-8000-000000000003',
  created: '71000000-0000-4000-8000-000000000004',
};
const people = {
  inProgress: '31000000-0000-4000-8000-000000000001',
  completed: '31000000-0000-4000-8000-000000000002',
  failed: '31000000-0000-4000-8000-000000000003',
};
export const ackToken = 'ack-synthetic-0001';
export const VOID_LIMIT = 50;

function exitItem(id: string, employeeId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    employeeId,
    code: `EX-${id.slice(-3)}`,
    name,
    departmentId: department,
    positionId: null,
    lastWorkDate: '2026-11-30',
    plannedLastWorkDate: '2026-11-30',
    effectiveDate: '2026-12-01',
    exitTypeCode: 'voluntary',
    exitTypeName: '主动离职',
    reasonCode: 'personal',
    reasonName: '个人原因',
    whereaboutsCode: null,
    whereaboutsName: null,
    status: 'in_review',
    mode: 'application',
    initiator: 'hr',
    initiatorUserId: user,
    batchId: null,
    revision: 3,
    createdAt: '2026-10-20T02:00:00.000Z',
    activation: null,
    cancellation: null,
    ...extra,
  } as Record<string, unknown> & { id: string; revision: number; status: string };
}
/** 详情 = 列表条目 + 原定 / 最终日期块 + 扩展字段（未登记的扩展字段对查看人裁剪，这里只留一个）。 */
const detailOf = (row: Record<string, unknown>, server: ExitServer) => ({
  ...row,
  // 详情投影只登记了 addToBlacklist，加黑三项不回（后端缺口，F 任务）
  addToBlacklist: server.blacklisted.includes(String(row.id)),
  dates: {
    planned: { lastWorkDate: row.plannedLastWorkDate, effectiveDate: '2026-12-01' },
    final: { lastWorkDate: row.lastWorkDate, effectiveDate: row.effectiveDate },
  },
});
const handover: Handover & { request: Record<string, unknown> } = {
  status: 'in_progress',
  request: {
    id: '72000000-0000-4000-8000-000000000001',
    exitRequestId: ids.completed,
    employeeId: people.completed,
    status: 'in_progress',
    endReason: null,
    notLaunchedReason: null,
    hint: null,
    approvalInstanceId: '73000000-0000-4000-8000-000000000001',
    revision: 1,
    mine: false,
    items: [
      {
        id: '74000000-0000-4000-8000-000000000001',
        category: '工作交接',
        sequenceNo: 1,
        title: '归还门禁卡',
        done: true,
      },
      { id: '74000000-0000-4000-8000-000000000002', category: '财务', sequenceNo: 2, title: '结清借款', done: false },
    ],
  },
};

export const viewStatuses: Record<string, string[]> = {
  in_progress: ['draft', 'in_review', 'approved', 'rejected'],
  completed: ['effective'],
};
const viewable = [
  ...['name', 'code', 'departmentId', 'positionId', 'lastWorkDate', 'effectiveDate', 'status', 'mode'],
  ...['exitTypeCode', 'reasonCode', 'whereaboutsCode', 'addToBlacklist'],
  ...['blacklistExpiryDate', 'blacklistReason', 'blacklistNote'],
];
const buttons = [
  ...['Employment.Dimission', 'Employment.DimissionApproval', 'Employment.DimissionEdit', 'Employment.DimissionCancel'],
  ...['EmploymentRecrdDetailDimissionHandoverApproval', 'Employment.HandoverReSubmit'],
]
  .map((buttonCode) => ({ buttonCode, level: 'detail' }))
  .concat({ buttonCode: 'BatchDimissionHandoverApproval', level: 'list' });
export const rowSubmit = 'EmploymentRecrdLineOpDimissionHandoverApproval';

export interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown>;
  ifMatch: string | undefined;
  key: string | undefined;
}
/** 可变的“服务端状态”：写接口改它，列表 / 详情 / 员工读取按它返回（直接离职进“离职中”，生效进“已完成”，撤销移出）。 */
export interface ExitServer {
  rows: ReturnType<typeof exitItem>[];
  employeeRevision: number;
  preview: 'ack' | 'tooMany';
  queries: URLSearchParams[];
  sent: Sent[];
  /** 列表行动作（GET /exits rowActions）：按单 id 给，交接发起后服务端不再下发。 */
  rowActions: Record<string, string[]>;
  /** 提交审批先被拒绝的次数（409 业务拒绝，不是版本冲突）。 */
  submitRejections: number;
  /** 发起交接前别人先改了离职单的次数：本次按旧 revision 提交得 409。 */
  handoverRaces: number;
  /** 批量发起交接逐人结果（缺省 launched）。 */
  batchOutcome: { outcome: string; reason?: string };
  /** 撤销 / 改期回执的下游清单：none = 各类目无数据（薪资未接入），found = 有命中与附加项。 */
  downstream: 'none' | 'found';
  /** 已加黑的离职单（详情 addToBlacklist = true，加黑三项缺席）。 */
  blacklisted: string[];
  /** GET /exits/:id/handover：按离职单 id，缺省为未发起。 */
  handovers: Record<string, Handover>;
}
type Handover = { status: string; request: null | (Record<string, unknown> & { id: string; revision: number }) };
/** 未发起成功的交接单（exit-handover.ts recordNotLaunched）：可重新提交，If-Match = 交接单 revision。 */
export function notLaunched(exitRequestId: string): Handover {
  const request = {
    ...handover.request,
    id: '72000000-0000-4000-8000-000000000002',
    exitRequestId,
    status: 'not_launched',
    notLaunchedReason: 'NO_INITIATOR_ACCOUNT',
    approvalInstanceId: null,
    revision: 1,
    items: [],
  };
  return { status: 'not_launched', request };
}
const record = (request: Request, path: string): Sent => ({
  method: request.method(),
  path,
  body: (request.postData() ? request.postDataJSON() : {}) as Record<string, unknown>,
  ifMatch: request.headers()['if-match'],
  key: request.headers()['idempotency-key'],
});

export async function setupExits(page: Page) {
  const server: ExitServer = {
    rows: [
      exitItem(ids.inProgress, people.inProgress, '合成离职中员工'),
      exitItem(ids.completed, people.completed, '合成已离职员工', { status: 'effective', mode: 'direct' }),
      exitItem(ids.failed, people.failed, '合成生效失败员工', {
        status: 'approved',
        // exit-queries.ts：activation 只带 status / reason / blockedByBusinessId；details 仅 EXIT_LATER_RECORD_EXISTS 才有
        activation: { status: 'failed', reason: 'EXIT_APPLICATIONS_TOO_MANY', blockedByBusinessId: null },
      }),
    ],
    employeeRevision: 5,
    preview: 'ack',
    queries: [],
    sent: [],
    rowActions: {},
    submitRejections: 0,
    handoverRaces: 0,
    batchOutcome: { outcome: 'launched' },
    downstream: 'none',
    blacklisted: [],
    handovers: { [ids.completed]: handover },
  };
  await routePermissions(page);
  await routeReferences(page);
  const own = /\/api\/tenant\/employment\/(exits|employees|exit-handover-requests)(\/|\?|$)/;
  await page.route(own, (route) => serve(route, server));
  await page.goto('/exits');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/exits');
  return server;
}

async function routePermissions(page: Page) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'transfer' ? { ...app, entryObjects: ['TenantBase.EmploymentRecord'] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: viewable,
        editableFields: viewable,
        buttons,
      },
    }),
  );
}

async function routeReferences(page: Page) {
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({ json: { items: [{ id: department, name: '合成离职部门' }], page: 1, pageSize: 20 } }),
  );
  await page.route(/\/org\/organizations\/[^/?]+/, (route) =>
    route.fulfill({ json: { id: department, name: '合成离职部门' } }),
  );
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成待离职员工' }], page: 1, pageSize: 20 } }),
  );
  await page.route(/\/exits\/dictionaries\/[a-z]+/, (route) => {
    const kind = new URL(route.request().url()).pathname.split('/').at(-1) as Kind;
    return route.fulfill({ json: { items: presetRows(kind) } });
  });
}

function serve(route: Route, server: ExitServer) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace('/api/tenant/employment', '');
  if (path.startsWith('/exits/dictionaries')) return route.fallback();
  if (request.method() === 'GET') return route.fulfill({ json: read(server, path, url.searchParams) });
  const sent = record(request, path);
  server.sent.push(sent);
  return route.fulfill(write(server, sent));
}

function read(server: ExitServer, path: string, query: URLSearchParams) {
  if (path === '/exits') {
    server.queries.push(query);
    const view = query.get('view') ?? '';
    const items = server.rows.filter((row) => !viewStatuses[view] || viewStatuses[view].includes(row.status));
    const rowActions = (row: { id: string }) => server.rowActions[row.id] ?? [];
    return {
      items: items.map((row) => ({ ...row, rowActions: rowActions(row) })),
      total: items.length,
      page: 1,
      pageSize: 30,
    };
  }
  if (path.startsWith('/employees/'))
    return { id: employee, code: 'EX-NEW', name: '合成待离职员工', revision: server.employeeRevision };
  const id = path.split('/')[2]!;
  if (path.endsWith('/handover')) return server.handovers[id] ?? { status: 'not_started', request: null };
  return detailOf(
    server.rows.find((row) => row.id === id)!,
    server,
  );
}

const conflict = { status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '数据已被他人修改' } } };
const business = (row: ReturnType<typeof exitItem>) => {
  const { id, employeeId, status, mode, revision } = row;
  return { id, employeeId, kind: 'leave', status, mode, revision, activation: null };
};

function write(server: ExitServer, sent: Sent) {
  if (sent.path.endsWith('/preview')) return { json: preview(server, String(sent.body.lastWorkDate)) };
  if (sent.path === `/exits/employees/${employee}`) return create(server, sent);
  if (sent.path === '/exits/handover/batch-submit') return batch(server, sent);
  if (sent.path.startsWith('/exit-handover-requests/')) return resubmit(server, sent);
  const row = server.rows.find((item) => sent.path.startsWith(`/exits/${item.id}`))!;
  if (/\/handover\/submit(-from-list)?$/.test(sent.path)) return handoverSubmit(server, row, sent);
  if (sent.ifMatch !== String(row.revision)) return conflict;
  if (sent.path.endsWith('/submit')) return submit(server, row);
  row.revision += 1;
  if (sent.path.endsWith('/cancel')) {
    const stateBefore = row.status;
    row.status = stateBefore === 'effective' ? 'deleted' : 'voided';
    const cancellation = { id: '76000000-0000-4000-8000-000000000001', stateBefore, reason: sent.body.reason };
    return { json: { ...business(row), cancellation, downstream: cancelDownstream(server) } };
  }
  const rescheduled = 'lastWorkDate' in sent.body && sent.body.lastWorkDate !== row.lastWorkDate;
  Object.assign(row, sent.body);
  return { json: { ...business(row), ...(rescheduled ? { downstreamHints: rescheduleHints(server) } : {}) } };
}

function create(server: ExitServer, sent: Sent) {
  server.employeeRevision += 1;
  const lastWorkDate = String(sent.body.lastWorkDate);
  const mode = String(sent.body.mode);
  const status = mode === 'application' ? 'draft' : 'approved';
  const row = exitItem(ids.created, employee, '合成待离职员工', { status, mode, lastWorkDate });
  server.rows.unshift({ ...row, plannedLastWorkDate: lastWorkDate, revision: 1 });
  return { status: 201, json: { ...business(server.rows[0]!), employeeRevision: server.employeeRevision } };
}

/** POST /exits/:id/submit：只收顶层 pendingTransferAck（strictObject），成功后进审批中。 */
function submit(server: ExitServer, row: ReturnType<typeof exitItem>) {
  if (server.submitRejections > 0) {
    server.submitRejections -= 1;
    return { status: 409, json: { error: { code: 'CONFLICT', message: '合成的提交拒绝原因' } } };
  }
  row.status = 'in_review';
  row.revision += 1;
  return { json: business(row) };
}

function handoverSubmit(server: ExitServer, row: ReturnType<typeof exitItem>, sent: Sent) {
  if (server.handoverRaces > 0) {
    server.handoverRaces -= 1;
    row.revision += 1;
  }
  if (sent.ifMatch !== String(row.revision)) return conflict;
  const requestId = '72000000-0000-4000-8000-000000000009';
  return { json: { exitRequestId: row.id, requestId, outcome: 'launched', revision: row.revision } };
}

/** POST /exit-handover-requests/:id/resubmit（exit-handover-resubmit.ts）：回交接单，revision 前进。 */
function resubmit(server: ExitServer, sent: Sent) {
  const request = Object.values(server.handovers).find((item) =>
    sent.path.includes(String(item.request?.id)),
  )!.request!;
  if (server.handoverRaces > 0) {
    server.handoverRaces -= 1;
    request.revision += 1;
  }
  if (sent.ifMatch !== String(request.revision)) return conflict;
  Object.assign(request, { status: 'in_progress', notLaunchedReason: null, revision: request.revision + 1 });
  const approvalInstanceId = '73000000-0000-4000-8000-000000000002';
  return { json: { requestId: request.id, status: 'in_progress', revision: request.revision, approvalInstanceId } };
}

/** 逐人回执（exit-handover-batch.ts）；发起后这些行不再有行动作。 */
function batch(server: ExitServer, sent: Sent) {
  const items = (sent.body.items as { exitRequestId: string }[]).map(({ exitRequestId }) => {
    delete server.rowActions[exitRequestId];
    return { exitRequestId, ...server.batchOutcome };
  });
  return { json: { items } };
}

const target = (type: string, id: string) => ({ type, id });
/** exit-downstream.ts probeDownstream 经 trimDownstream：固定四类 + 附加项；薪资档案未接入。 */
function cancelDownstream(server: ExitServer) {
  const found = server.downstream === 'found';
  const contract = found ? [target('contract', '77000000-0000-4000-8000-000000000001')] : [];
  const items = [
    { kind: 'contract', status: found ? 'found' : 'none', targets: contract, hiddenCount: found ? 1 : 0 },
    { kind: 'duty_transfer', status: 'none', targets: [], hiddenCount: 0 },
    { kind: 'handover', status: 'none', targets: [], hiddenCount: 0 },
    { kind: 'payroll', status: 'not_connected', targets: [], hiddenCount: 0 },
  ];
  const voided = target('employment-business', '78000000-0000-4000-8000-000000000001');
  const additional = found
    ? [{ kind: 'application_voided', action: 'reinitiate', targets: [voided], hiddenCount: 0 }]
    : [];
  return { items, additional };
}
/** exit-routes.ts PATCH 投影：items 只含 found，probes 列出各类目状态。 */
function rescheduleHints(server: ExitServer) {
  const probes = [
    { kind: 'payroll', status: 'not_connected' },
    { kind: 'social_insurance', status: 'none' },
    { kind: 'leave_balance', status: server.downstream === 'found' ? 'found' : 'none' },
  ];
  if (server.downstream !== 'found') return { items: [], probes };
  const balance = target('leave-balance', '79000000-0000-4000-8000-000000000001');
  return { items: [{ kind: 'leave_balance', status: 'found', targets: [balance], hiddenCount: 2 }], probes };
}

/** 追加一条离职单（合成），返回它的 id；页面需刷新后才看到。 */
export function addExit(server: ExitServer, name: string, extra: Record<string, unknown>) {
  const id = `71000000-0000-4000-8000-0000000001${String(server.rows.length).padStart(2, '0')}`;
  const person = `31000000-0000-4000-8000-0000000001${String(server.rows.length).padStart(2, '0')}`;
  server.rows.push(exitItem(id, person, name, extra));
  return id;
}

function preview(server: ExitServer, lastWorkDate: string) {
  const items = [{ id: '75000000-0000-4000-8000-000000000001', kind: 'transfer', effectiveDate: '2026-12-15' }];
  const base = { lastWorkDate, effectiveDate: '2026-12-01', blockers: [] };
  // warnings 第二项（已批准在后的调动先落地）后端总会给，无条目时 items 为空
  const landed = { reason: 'EXIT_FUTURE_TRANSFER_LANDED', items: [], hiddenCount: 0 };
  if (server.preview === 'tooMany')
    return { ...base, ack: null, warnings: [{ reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: VOID_LIMIT }, landed] };
  return {
    ...base,
    ack: { ackToken, items, hiddenCount: 0 },
    warnings: [{ reason: 'EXIT_APPLICATIONS_TO_VOID', items, hiddenCount: 0 }, landed],
  };
}

/** 模拟定时任务落地生效：离职中 → 已完成。 */
export function activate(server: ExitServer, id: string) {
  const row = server.rows.find((item) => item.id === id)!;
  row.status = 'effective';
  row.revision += 1;
}
