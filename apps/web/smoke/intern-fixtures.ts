import type { Page } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';

// 形态对照 intern-routes.ts trimInternItems（InternViewItem 按可见字段裁剪后的平铺对象）与 types.ts EmploymentBusiness。
export const department = '60000000-0000-4000-8000-000000000001';
export const target = '60000000-0000-4000-8000-000000000002';
export const manager = '60000000-0000-4000-8000-000000000003';
export const recordId = '40000000-0000-4000-8000-000000000011';
export const applicationId = '70000000-0000-4000-8000-000000000001';
export const employeeRevision = 5;
const base = {
  employeeId: employee,
  code: 'IN-DEMO-001',
  name: '合成实习生',
  entryDate: '2026-09-01',
  departmentId: department,
  positionId: null,
  employType: 'intern',
  revision: 2,
  lastWorkDate: null,
};
export const rows = {
  interning: {
    ...base,
    id: recordId,
    kind: 'hire',
    effectiveDate: '2026-09-01',
    employeeStatus: 3,
    state: 'effective',
  },
  converting: {
    ...base,
    id: applicationId,
    kind: 'intern_regularization',
    effectiveDate: '2026-10-20',
    employType: 'internal',
    employeeStatus: 2,
    revision: 3,
    state: 'in_review',
  },
  converted: {
    ...base,
    id: '40000000-0000-4000-8000-000000000012',
    kind: 'intern_regularization',
    effectiveDate: '2026-10-16',
    employType: 'internal',
    employeeStatus: 2,
    state: 'effective',
    probation: { startDate: '2026-10-16', months: 1, endDate: '2026-11-15' },
  },
  left: {
    ...base,
    id: '40000000-0000-4000-8000-000000000013',
    kind: 'leave',
    effectiveDate: '2026-11-01',
    employeeStatus: 8,
    state: 'effective',
    lastWorkDate: '2026-10-31',
  },
} as const;
export type InternViewKey = keyof typeof rows;

/** 写回执：EmploymentBusiness（新建类命令员工 revision + 1）。 */
export function business(kind: string, extra: Record<string, unknown> = {}) {
  return {
    id: '80000000-0000-4000-8000-000000000001',
    employeeId: employee,
    revision: 1,
    employeeRevision: employeeRevision + 1,
    status: 'effective',
    kind,
    changeType: kind === 'leave' ? 'intern_end' : 'intern_regularization',
    mode: 'direct',
    formId: 'standard',
    effectiveDate: '2026-10-16',
    fields: { departmentId: target },
    customFields: {},
    employeeStatus: 2,
    entryStatus: null,
    record: null,
    activation: null,
    ...extra,
  };
}
export const conflict = (message: string, details: Record<string, unknown>) => ({
  status: 409,
  json: { error: { code: 'CONFLICT', message, details } },
});

export const allButtons = [
  'Employment.Create',
  'Employment.Dimission',
  'Employment.Submit',
  'Employment.Withdraw',
  'Employment.Revoke',
];
const viewable = ['name', 'code', 'departmentId', 'positionId', 'effectiveDate', 'directManagerId', 'dottedManagerId'];
export interface Options {
  buttons?: string[];
  viewableFields?: string[];
}
/**
 * 可变的“服务端状态”：用例在写接口里改它，写后回读（员工 / 申请单 revision、列表）按它返回。
 * record 是当前主职任职（GET /employees/:id/records 的 isCurrent + primary 行的 fields）。
 */
export interface Server {
  employeeRevision: number;
  businessRevision: number;
  record: Record<string, unknown>;
  listStatus: number;
  /** 受控交错：员工读取在应答前等待它（用例按需挂上）。 */
  beforeEmployee?: () => Promise<void>;
  /** 受控交错：任职记录应答后调用（模拟另一位 HR 随即改了任职）。 */
  afterRecords?: () => void;
}
/** 列表请求按 view 返回对应视图的一行；读回 query 便于断言。 */
export async function setup(page: Page, options: Options = {}) {
  const queries: URLSearchParams[] = [];
  const server: Server = {
    employeeRevision,
    businessRevision: rows.converting.revision,
    record: { departmentId: department, positionId: null, directManagerId: null, dottedManagerId: null },
    listStatus: 200,
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
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: options.viewableFields ?? viewable,
        editableFields: options.viewableFields ?? viewable,
        buttons: (options.buttons ?? allButtons).map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    }),
  );
  await page.route('**/employment/interns?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const view = (query.get('view') ?? 'interning') as InternViewKey;
    if (server.listStatus !== 200)
      return route.fulfill({
        status: server.listStatus,
        json: { error: { code: 'UNAVAILABLE', message: '暂不可用' } },
      });
    return route.fulfill({
      json: { items: [rows[view]], page: Number(query.get('page')), pageSize: 30, hasDataPermission: true },
    });
  });
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: department, name: '合成实习部门' },
          { id: target, name: '合成转正部门' },
        ],
      },
    }),
  );
  await page.route(/\/org\/organizations\/[^/?]+/, (route) =>
    route.fulfill({ json: { id: department, name: '合成实习部门' } }),
  );
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({ json: { items: [{ id: manager, name: '合成经理' }], page: 1, pageSize: 20 } }),
  );
  await page.route(`**/personnel/employees/${employee}`, (route) =>
    route.fulfill({ json: { id: employee, name: base.name, code: base.code, revision: 1 } }),
  );
  await routeServer(page, server);
  await page.goto('/interns');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/interns');
  return { queries, server };
}

/** 员工 revision、当前主职任职与申请单 revision 按“服务端状态”返回（打开基线、409 重读与写后回读都读这里）。 */
async function routeServer(page: Page, server: Server) {
  await page.route(`**/employment/employees/${employee}`, async (route) => {
    await server.beforeEmployee?.();
    return route.fulfill({
      json: { id: employee, code: base.code, name: base.name, revision: server.employeeRevision },
    });
  });
  await page.route(`**/employment/employees/${employee}/records?*`, async (route) => {
    const fields = server.record;
    await route.fulfill({
      json: {
        items: [{ id: recordId, employeeId: employee, serviceType: 'primary', isCurrent: true, fields }],
        page: 1,
        pageSize: 200,
        hasDataPermission: true,
      },
    });
    server.afterRecords?.();
  });
  await page.route('**/employment/businesses/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: { id, employeeId: employee, revision: server.businessRevision } });
  });
}

const labels = { interning: '实习中', converting: '实习转正中', converted: '已转正', left: '已离职' } as const;
/** 打开某视图首行的详情：等该视图的列表返回后再点，确保点到的是本视图的行。 */
export async function openDetail(page: Page, view: InternViewKey) {
  const button = page.getByRole('button', { name: labels[view], exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') {
    const loaded = page.waitForResponse((response) => response.url().includes(`view=${view}`));
    await button.click();
    await loaded;
  }
  const marker = { interning: '正式', converting: '审批中', converted: '2026-11-15', left: '2026-10-31' }[view];
  await page
    .locator('.intern-table tr.ant-table-row')
    .filter({ hasText: marker })
    .getByRole('button', { name: '查看详情', exact: true })
    .click();
  await page.getByRole('heading', { name: base.name, exact: true }).waitFor();
}
