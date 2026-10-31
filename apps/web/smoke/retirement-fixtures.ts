import type { Page } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';

// 形态对照 retirement-views.ts（员工行 personCandidates 的列；退休单行 toRetirementItem：离职行去掉离职专用列，
// 加 retireType / reEmployed / expectedRetirementDate）、exit-queries.ts exitDetailPayload、exit-preview.ts previewExit、
// retirement-intention-store.ts intentionView 与 types.ts EmploymentBusiness。数据全部为合成值。
export const department = '60000000-0000-4000-8000-000000000001';
export const receiver = '60000000-0000-4000-8000-000000000003';
export const subordinate = '60000000-0000-4000-8000-000000000004';
export const billId = '40000000-0000-4000-8000-000000000021';
export const draftId = '40000000-0000-4000-8000-000000000022';
export const intentionId = '70000000-0000-4000-8000-000000000031';
export const ackToken = 'ack-synthetic-0001';
export const employeeRevision = 5;
const name = '合成退休员工';
const code = 'RT-DEMO-001';

export const person = {
  employeeId: employee,
  code,
  name,
  departmentId: department,
  positionId: null,
  expectedRetirementDate: '2026-11-30',
  daysToRetirement: 31,
  earliestRetirementDate: '2026-08-31',
  latestRetirementDate: '2029-11-30',
};
export function bill(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: billId,
    employeeId: employee,
    code,
    name,
    departmentId: department,
    positionId: null,
    lastWorkDate: '2026-11-29',
    plannedLastWorkDate: '2026-11-29',
    effectiveDate: '2026-11-30',
    status,
    mode: 'direct',
    initiator: 'hr',
    initiatorUserId: '50000000-0000-4000-8000-000000000001',
    batchId: null,
    revision: 2,
    createdAt: '2026-10-20T02:00:00.000Z',
    activation: null,
    cancellation: null,
    retireType: 'early',
    reEmployed: false,
    expectedRetirementDate: '2026-11-30',
    ...extra,
  };
}
/** 详情 = 退休单行 + 扩展行 + 载荷版本 / 状态事件 / 效果台账 / 职责转交汇总 + 原定 / 最终日期块。 */
export function detail(row: ReturnType<typeof bill>) {
  return {
    ...row,
    handoverEmployeeId: receiver,
    addToBlacklist: false,
    dutyTransferTiming: 'on_effective',
    preReleaseDate: null,
    versions: [
      {
        versionNo: 1,
        effectiveDate: row.effectiveDate,
        plannedEffectiveDate: row.effectiveDate,
        lastWorkDate: row.lastWorkDate,
        createdAt: row.createdAt,
      },
    ],
    events: [{ eventNo: 1, state: row.status, createdAt: row.createdAt }],
    approvalInstanceId: null,
    effects: [],
    dutyTransfer: { timing: 'on_effective', transferred: 0, failed: 0 },
    dates: {
      planned: { lastWorkDate: row.plannedLastWorkDate, effectiveDate: row.effectiveDate },
      final: { lastWorkDate: row.lastWorkDate, effectiveDate: row.effectiveDate },
    },
  };
}
/** 预览：有一条在途调动要确认（ack 带令牌与披露 {items, hiddenCount}），作废 / 已落地调动各为空。 */
export function preview(lastWorkDate: string) {
  return {
    lastWorkDate,
    effectiveDate: '2026-11-30',
    expectedRetirementDate: '2026-11-30',
    retireType: 'early',
    blockers: [],
    ack: { ackToken, items: [{ businessId: draftId, effectiveDate: '2026-12-01' }], hiddenCount: 0 },
    warnings: [
      {
        reason: 'EXIT_APPLICATIONS_TO_VOID',
        items: [{ businessId: draftId, effectiveDate: '2026-12-01' }],
        hiddenCount: 1,
      },
      { reason: 'EXIT_FUTURE_TRANSFER_LANDED', items: [], hiddenCount: 0 },
    ],
  };
}
/** 写回执：EmploymentBusiness（新建员工 revision + 1；单据命令本单 revision + 1）。 */
export function business(extra: Record<string, unknown> = {}) {
  return {
    id: billId,
    employeeId: employee,
    revision: 1,
    employeeRevision: employeeRevision + 1,
    status: 'approved',
    kind: 'retirement',
    changeType: null,
    mode: 'direct',
    formId: 'standard',
    effectiveDate: '2026-11-30',
    probation: false,
    probationMonths: null,
    probationEndDate: null,
    fields: { departmentId: department },
    customFields: {},
    employeeStatus: 2,
    entryStatus: null,
    record: null,
    activation: null,
    ...extra,
  };
}
export function intention(status: string, revision = 1, extra: Record<string, unknown> = {}) {
  return {
    id: intentionId,
    employeeId: employee,
    status,
    intendedDate: '2026-12-31',
    reason: null,
    expectedDateSnapshot: '2026-11-30',
    earliestSnapshot: '2026-08-31',
    latestSnapshot: '2029-11-30',
    revision,
    ...extra,
  };
}
export const conflict = (message: string, details: Record<string, unknown>) => ({
  status: 409,
  json: { error: { code: 'CONFLICT', message, details } },
});

export const allButtons = [
  'Employment.Retire',
  'Employment.RetireApproval',
  'Employment.RetireCancel',
  'Employment.RetireIntention',
];
const fields = [
  'name',
  'code',
  'departmentId',
  'positionId',
  'lastWorkDate',
  'effectiveDate',
  'status',
  'mode',
  'retireType',
  'reEmployed',
  'createdAt',
  'handoverEmployeeId',
  'intendedDate',
  'reason',
];
export interface Options {
  buttons?: string[];
  viewableFields?: string[];
  /** 人员对象（TenantBase.Employee）可见字段：预计退休日期不可见时隐藏“即将退休天数”。 */
  employeeFields?: string[];
}
export type ViewKey = 'upcoming' | 'overdue' | 'processing' | 'completed' | 'all';
/** 可变的“服务端状态”：写接口改它，列表 / 详情 / 写后回读按它返回。 */
export interface Server {
  views: Record<ViewKey, Record<string, unknown>[]>;
  employeeRevision: number;
  billRevision: number;
  intentions: Record<string, unknown>[];
}
export async function setup(page: Page, options: Options = {}) {
  const queries: URLSearchParams[] = [];
  const server: Server = {
    views: {
      upcoming: [person],
      overdue: [],
      processing: [],
      completed: [bill('effective')],
      all: [bill('effective')],
    },
    employeeRevision,
    billRevision: 2,
    intentions: [],
  };
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
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const person = objectCode === 'TenantBase.Employee';
    const viewable = person ? (options.employeeFields ?? ['name', 'code', 'expectedRetirementDate']) : undefined;
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { read: true, create: true, update: true },
        viewableFields: viewable ?? options.viewableFields ?? fields,
        editableFields: viewable ?? options.viewableFields ?? fields,
        buttons: (options.buttons ?? allButtons).map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    });
  });
  await page.route('**/employment/retirements?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const view = (query.get('view') ?? 'upcoming') as ViewKey;
    return route.fulfill({
      json: {
        items: server.views[view],
        total: server.views[view].length,
        asOf: query.get('asOf') ?? '2026-10-30',
        page: Number(query.get('page')),
        pageSize: Number(query.get('pageSize')),
        hasDataPermission: true,
        ...(view === 'upcoming' ? { upcomingDays: Number(query.get('upcomingDays') ?? 90) } : {}),
      },
    });
  });
  await page.route(`**/employment/retirements/${billId}`, (route) => {
    const row = server.views.all.find((item) => item.id === billId) as ReturnType<typeof bill> | undefined;
    if (!row) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '任职业务不存在' } } });
    return route.fulfill({ json: detail({ ...row, revision: server.billRevision }) });
  });
  await routeReferences(page);
  await routeServer(page, server);
  await page.goto('/retirements');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/retirements');
  return { queries, server };
}

/** 部门 / 人员引用（列表名称、职责接收人与下属选择）。 */
async function routeReferences(page: Page) {
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({ json: { items: [{ id: department, name: '合成退休部门' }] } }),
  );
  await page.route(/\/org\/organizations\/[^/?]+/, (route) =>
    route.fulfill({ json: { id: department, name: '合成退休部门' } }),
  );
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: receiver, name: '合成接收人' },
          { id: subordinate, name: '合成下属' },
        ],
        page: 1,
        pageSize: 20,
      },
    }),
  );
  await page.route(/\/personnel\/employees\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const label = id === receiver ? '合成接收人' : id === subordinate ? '合成下属' : name;
    return route.fulfill({ json: { id, name: label, code, revision: 1 } });
  });
}

/** 员工 revision、单据 revision 与意向申请按“服务端状态”返回（打开基线、409 重读与写后回读都读这里）。 */
async function routeServer(page: Page, server: Server) {
  await page.route(`**/employment/employees/${employee}`, (route) =>
    route.fulfill({ json: { id: employee, code, name, revision: server.employeeRevision } }),
  );
  await page.route('**/employment/businesses/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: { id, employeeId: employee, revision: server.billRevision } });
  });
  await page.route('**/employment/retirement-intentions?*', (route) =>
    route.fulfill({ json: { items: server.intentions, total: server.intentions.length, page: 1, pageSize: 50 } }),
  );
  await page.route(`**/employment/retirement-intentions/${intentionId}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: server.intentions[0] });
  });
}

const labels: Record<ViewKey, string> = {
  upcoming: '即将退休',
  overdue: '过期未退休',
  processing: '退休中',
  completed: '已完成的退休',
  all: '全部退休记录',
};
export async function switchView(page: Page, view: ViewKey) {
  const button = page.getByRole('button', { name: labels[view], exact: true });
  if ((await button.getAttribute('aria-pressed')) === 'true') return;
  const loaded = page.waitForResponse((response) => response.url().includes(`view=${view}`));
  await button.click();
  await loaded;
}
/** 打开某视图首行的详情：等该视图的列表返回后再点，确保点到的是本视图的行。 */
export async function openRow(page: Page, view: ViewKey) {
  await switchView(page, view);
  await page.locator('.retirement-table tr.ant-table-row').first().getByRole('button', { name: '查看详情' }).click();
}
