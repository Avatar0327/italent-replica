import type { Page, Request, Route } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';
import { presetRows, type Kind } from './exit-fixtures.js';

// 形态对照（FE-R2c2）：列表 = exit-queries.ts ExitItem 经 trimExit 后平铺 + rowActions（exit-routes.ts GET /exits）；
// 详情 = exitDetailPayload（多 dates 与 ExitExtension 字段）；提交前检查 = exit-preview.ts previewExit；
// 交接区 = exit-handover.ts exitHandoverStatus；写回执 = EmploymentBusiness / 业务头（kind: 'leave'）。数据全部为合成值。
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
const detailOf = (row: Record<string, unknown>) => ({
  ...row,
  addToBlacklist: false,
  dates: {
    planned: { lastWorkDate: row.plannedLastWorkDate, effectiveDate: '2026-12-01' },
    final: { lastWorkDate: row.lastWorkDate, effectiveDate: row.effectiveDate },
  },
});
const handover = {
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
  'Employment.Dimission',
  'Employment.DimissionApproval',
  'Employment.DimissionEdit',
  'Employment.DimissionCancel',
].map((buttonCode) => ({ buttonCode, level: 'detail' }));

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
  };
  await routePermissions(page);
  await routeReferences(page);
  await page.route(/\/api\/tenant\/employment\/(exits|employees)(\/|\?|$)/, (route) => serve(route, server));
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
    return { items: items.map((row) => ({ ...row, rowActions: [] })), total: items.length, page: 1, pageSize: 30 };
  }
  if (path.startsWith('/employees/'))
    return { id: employee, code: 'EX-NEW', name: '合成待离职员工', revision: server.employeeRevision };
  const id = path.split('/')[2]!;
  if (path.endsWith('/handover')) return id === ids.completed ? handover : { status: 'not_started', request: null };
  return detailOf(server.rows.find((row) => row.id === id)!);
}

function write(server: ExitServer, sent: Sent) {
  if (sent.path.endsWith('/preview')) return { json: preview(server, String(sent.body.lastWorkDate)) };
  if (sent.path === `/exits/employees/${employee}`) {
    server.employeeRevision += 1;
    const lastWorkDate = String(sent.body.lastWorkDate);
    const row = exitItem(ids.created, employee, '合成待离职员工', { status: 'approved', mode: 'direct', lastWorkDate });
    server.rows.unshift({ ...row, plannedLastWorkDate: lastWorkDate, revision: 1 });
    const receipt = { id: ids.created, employeeId: employee, kind: 'leave', status: 'approved', revision: 1 };
    const json = { ...receipt, employeeRevision: server.employeeRevision, mode: 'direct', activation: null };
    return { status: 201, json };
  }
  const row = server.rows.find((item) => sent.path.startsWith(`/exits/${item.id}`))!;
  row.revision += 1;
  if (sent.path.endsWith('/cancel')) row.status = 'cancelled';
  else Object.assign(row, sent.body);
  const { id, employeeId, status, revision } = row;
  return { json: { id, employeeId, kind: 'leave', status, revision } };
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
