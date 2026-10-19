import type { Page } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';

export const recordId = '40000000-0000-4000-8000-000000000001';
export const requestId = '50000000-0000-4000-8000-000000000001';
export const record = {
  id: recordId,
  employeeId: employee,
  staffId: employee,
  entryDate: '2025-01-01',
  kind: 'part_time',
  serviceType: 'part_time',
  effectiveDate: '2026-09-01',
  endDate: '2026-11-30',
  revision: 1,
  fields: { departmentId: '60000000-0000-4000-8000-000000000001', positionId: null, levelId: null },
  customFields: {},
  serviceStatus: 'serving',
  partTimeView: ['ongoing', 'all'],
};
// 对照 PT-5 queries.ts：姓名/工号在 employee；档案列表和记录详情没有 employee。
export const listRecord = { ...record, employee: { name: '合成兼职员工', code: 'PT-DEMO-001' } };
export const request = {
  id: requestId,
  employeeId: employee,
  revision: 1,
  kind: 'extend',
  status: 'in_review',
  initiator: 'hr',
  processCode: null,
  versionNo: 1,
  serviceType: 'part_time',
  effectiveDate: '2026-09-01',
  endDate: '2026-12-31',
  originalEndDate: '2026-11-30',
  requestRemark: '合成延期说明',
  recordId,
  fields: record.fields,
  customFields: {},
  warnings: [],
  employee: listRecord.employee,
  primary: null,
};
export const detail = {
  ...record,
  terms: [
    { termNo: 1, endDate: '2026-10-31', source: 'create', createdAt: '2026-09-01T00:00:00Z', previous: null },
    {
      termNo: 2,
      endDate: '2026-11-30',
      source: 'extend',
      createdAt: '2026-09-02T00:00:00Z',
      requestId,
      previous: { termNo: 1, endDate: '2026-10-31' },
    },
  ],
  requests: [
    {
      id: requestId,
      kind: 'extend',
      status: 'effective',
      initiator: 'hr',
      createdAt: '2026-09-02T00:00:00Z',
      serviceType: 'part_time',
      endDate: '2026-11-30',
      originalEndDate: '2026-10-31',
    },
  ],
};
export const fields = [
  'name',
  'code',
  'departmentId',
  'serviceType',
  'effectiveDate',
  'endDate',
  'directManagerId',
  'postId',
  'positionId',
  'levelId',
  'kind',
  'status',
  'serviceStatus',
  'partTimeView',
];
export async function setup(page: Page, path = '/part-time') {
  await permissions(page);
  await page.route('**/employment/part-times?*', (route) => {
    const { primary: _primary, warnings: _warnings, ...approval } = request;
    const q = new URL(route.request().url()).searchParams;
    const items =
      q.get('view') === 'in_approval'
        ? ['add', 'extend', 'end'].map((kind, index) => ({
            ...approval,
            id: `${requestId.slice(0, -1)}${index + 1}`,
            kind,
            initiatorUserId: user,
            createdAt: '2026-09-02T00:00:00Z',
            serviceStatus: 'serving',
          }))
        : [listRecord];
    return route.fulfill({
      json: {
        items,
        total: 61,
        page: Number(q.get('page')),
        pageSize: Number(q.get('pageSize')),
        hasDataPermission: true,
      },
    });
  });
  await page.route(`**/employment/part-times/${recordId}`, (route) => route.fulfill({ json: detail }));
  await page.route('**/employment/part-time-requests/*', (route) => route.fulfill({ json: request }));
  await page.route(`**/employment/employees/${employee}/part-times?*`, (route) =>
    route.fulfill({
      json: {
        items: [record],
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.route(`**/personnel/employees/${employee}`, (route) =>
    route.fulfill({
      json: {
        id: employee,
        ...listRecord.employee,
        revision: 1,
      },
    }),
  );
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({
      json: {
        items: [{ id: employee, ...listRecord.employee }],
        page: 1,
        pageSize: 15,
        hasDataPermission: true,
      },
    }),
  );
  await page.goto(path);
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto(path);
}

async function permissions(page: Page) {
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
        dataOperations: { read: true },
        viewableFields: fields,
        editableFields: [],
        buttons: [],
      },
    }),
  );
}
