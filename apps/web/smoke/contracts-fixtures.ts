// F-127b 合同协议冒烟共用夹具：权限快照、列表 / 详情 / 配置接口桩，数据全部为合成值。
import { expect, user, snapshotFixture, tenant } from './fixtures.js';
import type { Locator, Page, Request } from '@playwright/test';
import { objectPermissions, type ObjectPermissionFixture } from './contracts-permissions.js';

export const id = '40000000-0000-4000-8000-000000000001';
export const requestId = '40000000-0000-4000-8000-000000000002';
export const instance = '50000000-0000-4000-8000-000000000001';
export const task = '50000000-0000-4000-8000-000000000002';
export const record = {
  id,
  employeeId: 'employee',
  number: 'DEMO-CT-001',
  typeId: 'type',
  companyId: 'company',
  termType: 'fixed',
  effectiveDate: '2026-01-01',
  endDate: '2027-01-01',
  termMonths: 12,
  signingCount: 7,
  status: 'valid',
  approvalStatus: 'effective',
  rootContractId: id,
  versionNo: 2,
  revision: 3,
  employment: { entryDate: '2020-03-01', departmentId: 'dept', postId: 'post' },
};
export const pending = {
  id: requestId,
  employeeId: 'employee',
  operation: 'change',
  status: 'in_review',
  approvalStatus: 'in_review',
  rowType: 'request',
  revision: 1,
};
export const typeRow = { id: 'type', code: 'DEMO-T', name: '合成合同类型', enabled: true, revision: 2 };
export const ruleRow = {
  id: 'rule',
  name: '合成续签规则',
  priority: 1,
  enabled: true,
  orgIds: [],
  personIds: [],
  details: [{ typeId: 'type', daysBefore: 30, months: 12, initiatorId: user, skipTypeIds: [] }],
  revision: 5,
};
export const settingsRow = {
  tenantId: tenant,
  revision: 2,
  autoRenew: false,
  autoTerminate: true,
  accumulateRehire: false,
  postExitTypeIds: [],
  indefiniteTypeIds: [],
  renewalTypeIds: [],
  autoNumber: true,
  uniqueFields: ['number'],
};
function listRow(view: string | null) {
  if (view === 'missing')
    return {
      employeeId: 'employee',
      name: '合成甲',
      code: 'DEMO-001',
      employment: { entryDate: '2021-05-01', departmentId: 'dept', postId: 'post' },
    };
  if (view === 'in_review') return pending;
  return { ...record, ...(view === 'all' ? { rowType: 'contract' } : {}) };
}
async function contractRoutes(page: Page) {
  await page.route('**/api/tenant/contracts?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const items = params.get('keyword') === '不存在' ? [] : [listRow(params.get('view'))];
    return route.fulfill({ json: { items, total: items.length, hasDataPermission: true } });
  });
  await page.route('**/api/tenant/contracts/records/*', (route) => route.fulfill({ json: record }));
  await page.route('**/api/tenant/contracts/master-data/types?*', (route) =>
    route.fulfill({ json: { items: [typeRow] } }),
  );
  await page.route('**/api/tenant/contracts/master-data/companies?*', (route) =>
    route.fulfill({ json: { items: [{ id: 'company', code: 'DEMO-C', name: '合成公司', enabled: true }] } }),
  );
  await page.route('**/api/tenant/contracts/rules?*', (route) =>
    route.fulfill({ json: { items: [ruleRow], total: 1, page: 1, pageSize: 15 } }),
  );
  await page.route('**/api/tenant/contracts/settings', (route) => route.fulfill({ json: settingsRow }));
  // 任职摘要与人员只给 ID，名称按组织 / 岗位 / 人员详情接口解析（references.tsx NameOf）。
  for (const [path, name] of [
    ['org/organizations/dept', '合成部门'],
    ['job/posts/post', '合成职务'],
    ['personnel/employees/employee', '合成甲'],
  ])
    await page.route(
      (url) => url.pathname === `/api/tenant/${path}`,
      (route) => route.fulfill({ json: { id: path, name } }),
    );
}
/** overrides 按对象编码替换权限夹具；未登记的对象按无权限 403 返回。 */
export async function setupContracts(page: Page, overrides: Record<string, ObjectPermissionFixture> = {}) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'staff' ? { ...app, entryObjects: [...app.entryObjects, 'TenantBase.EmploymentContract'] } : app,
        ),
      },
    }),
  );
  const permissions = new Map(Object.values(objectPermissions).map((entry) => [entry.objectCode, entry]));
  for (const [code, entry] of Object.entries(overrides)) permissions.set(code, entry);
  await page.route('**/permission/me/objects/*', (route) => {
    const json = permissions.get(decodeURIComponent(route.request().url().split('/').at(-1)!));
    return json
      ? route.fulfill({ json })
      : route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问该对象' } } });
  });
  await contractRoutes(page);
  await page.setViewportSize({ width: 1512, height: 754 });
  await page.goto('/contracts');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/contracts');
}

/** 记录写请求：路径、方法、If-Match、命令 ID 与请求体。 */
export type Write = { path: string; method: string; revision?: string; command?: string; body: unknown };
export function capture(writes: Write[], request: Request) {
  writes.push({
    path: new URL(request.url()).pathname,
    method: request.method(),
    revision: request.headers()['if-match'],
    command: request.headers()['idempotency-key'],
    body: request.postDataJSON(),
  });
}
export const item = (scope: Locator, label: string) =>
  scope
    .locator('.ant-form-item')
    .filter({ has: scope.page().locator('.ant-form-item-label').getByText(label, { exact: true }) });
export async function choose(scope: Locator, label: string, option: string) {
  await item(scope, label).locator('.ant-select-selector').click();
  await scope
    .page()
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: option })
    .click();
}
export async function pickDate(scope: Locator, label: string, date: string) {
  const input = item(scope, label).getByPlaceholder('选择日期');
  await input.click();
  await input.fill(date);
  // 不按回车：只有一个输入框的表单（终止）回车会触发浏览器隐式提交。
  await input.press('Tab');
  await expect(input).toHaveValue(date);
}
export const save = { name: /保\s*存/, exact: true } as const;
/** antd 会在两个汉字的按钮中间插空格（“新 签”），按钮名按字间可有空白匹配。 */
export const named = (text: string) => ({ name: new RegExp(`^${[...text].join('\\s*')}$`) });
