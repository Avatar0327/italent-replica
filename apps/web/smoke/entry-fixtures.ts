// FE-R2b-2：只在浏览器测试中拦截 API；形态对照 employment/entry-{routes,views,email}.ts。
// 全部身份、组织、人员与合同值均为合成数据，无数据库种子。
import type { Page } from '@playwright/test';
import { snapshotFixture, tenant, user } from './fixtures.js';
import { capture, type Write } from './contracts-fixtures.js';

export const entryId = '71000000-0000-4000-8000-000000000001';
export const personId = '71000000-0000-4000-8000-000000000002';
export const departmentId = '71000000-0000-4000-8000-000000000003';
export const companyId = '71000000-0000-4000-8000-000000000004';
export const typeId = '71000000-0000-4000-8000-000000000005';
export const nextId = '71000000-0000-4000-8000-000000000006';
export const initialEntry = {
  id: entryId,
  employeeId: personId,
  name: '合成入职甲',
  code: 'SYN-ENTRY-001',
  kind: 'hire',
  effectiveDate: '2026-10-15',
  employeeStatus: 1,
  entryStatus: 0,
  departmentId,
  revision: 4,
};
export const entryFields = ['effectiveDate', 'departmentId', 'employType'];
export const contractFields = [
  'companyId',
  'typeId',
  'termType',
  'termMonths',
  'endDate',
  'effectiveDate',
  'probationStartDate',
  'probationEndDate',
];

export async function setupEntries(page: Page, baseURL: string) {
  const state = {
    row: { ...initialEntry },
    removed: false,
    email: {
      status: 'generated',
      email: 'synthetic.entry@example.invalid',
      ruleId: typeId,
      ruleName: '合成邮箱规则',
    } as Record<string, string>,
    error: undefined as string | undefined,
    writes: [] as Write[],
    reads: [] as string[],
  };
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  await permissions(page);
  await employmentRoutes(page, state);
  await page.route('**/api/tenant/contracts/master-data/*?*', (route) => {
    const company = new URL(route.request().url()).pathname.endsWith('/companies');
    return route.fulfill({
      json: {
        items: [
          {
            id: company ? companyId : typeId,
            code: 'SYN-REF',
            name: company ? '合成法人公司' : '合成合同类型',
            enabled: true,
            revision: 1,
          },
        ],
      },
    });
  });
  await page.route(`**/api/tenant/org/organizations/${departmentId}*`, (route) =>
    route.fulfill({ json: { id: departmentId, name: '合成入职部门' } }),
  );
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.goto('/entries');
  return state;
}

type EntryState = Awaited<ReturnType<typeof setupEntries>>;
function business(state: EntryState) {
  return {
    id: state.row.id,
    employeeId: personId,
    revision: state.row.revision,
    employeeRevision: 8,
    status: state.removed ? 'deleted' : 'effective',
    kind: 'hire',
    changeType: null,
    mode: 'direct',
    formId: 'standard',
    effectiveDate: state.row.effectiveDate,
    fields: { departmentId, employType: 'internal' },
    customFields: {},
    employeeStatus: state.row.employeeStatus,
    entryStatus: state.row.entryStatus,
    record: state.removed ? null : record(state),
    activation: null,
  };
}
function record(state: EntryState) {
  return {
    id: state.row.id,
    tenantId: tenant,
    employeeId: personId,
    revision: state.row.revision,
    staffId: personId,
    entryDate: state.row.effectiveDate,
    serviceType: 'primary',
    kind: 'hire',
    changeType: null,
    effectiveDate: state.row.effectiveDate,
    stopDate: '9999-12-31',
    previousRecordId: null,
    fields: { departmentId, employType: 'internal' },
    customFields: {},
    employeeStatus: state.row.employeeStatus,
    entryStatus: state.row.entryStatus,
    isCurrent: true,
    isLatest: true,
    status: 'effective',
    isInserted: false,
  };
}

async function permissions(page: Page) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, today: '2026-10-15' },
      },
    }),
  );
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const contract = objectCode === 'TenantBase.EmploymentContract';
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { create: true, update: true, delete: true },
        viewableFields: [
          'id',
          'revision',
          'name',
          'code',
          'employeeId',
          'employeeStatus',
          'entryStatus',
          'kind',
          ...entryFields,
          ...contractFields,
        ],
        editableFields: contract ? contractFields : entryFields,
        buttons: ['Employment.Edit', 'Employment.Delete'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    });
  });
}

async function employmentRoutes(page: Page, state: EntryState) {
  await page.route('**/api/tenant/employment/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'GET') {
      state.reads.push(path + url.search);
      if (path.endsWith('/pending-entries')) {
        const view = url.searchParams.get('view');
        const pending = state.row.employeeStatus === 1;
        const included =
          view === 'hired'
            ? !pending
            : view === 'cancelled'
              ? pending && state.row.entryStatus === 1
              : pending &&
                state.row.entryStatus !== 1 &&
                (view !== 'today' || state.row.effectiveDate === '2026-10-15');
        return route.fulfill({
          json: {
            items: !state.removed && included ? [state.row] : [],
            page: 1,
            pageSize: 30,
            hasDataPermission: true,
          },
        });
      }
      if (path.includes('/businesses/')) return route.fulfill({ json: business(state) });
      if (path.includes('/records/')) return route.fulfill({ json: record(state) });
      if (path.includes('/employees/'))
        return route.fulfill({
          json: {
            id: personId,
            name: state.row.name,
            code: state.row.code,
            revision: 8,
            status: state.row.employeeStatus === 1 ? 'pending' : 'employed',
            employeeStatus: state.row.employeeStatus,
            entryStatus: state.row.entryStatus,
          },
        });
      return route.fallback();
    }
    capture(state.writes, request);
    if (state.error)
      return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_FAILED', message: state.error } } });
    if (path.endsWith('/generate-email')) return route.fulfill({ json: state.email });
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (path.endsWith('/complete')) state.row.employeeStatus = body?.probation ? 2 : 3;
    if (path.endsWith('/cancel')) state.row.entryStatus = 1;
    if (path.endsWith('/postpone')) {
      state.row = { ...state.row, id: nextId, revision: 0, effectiveDate: String(body?.effectiveDate), entryStatus: 2 };
    }
    if (request.method() === 'DELETE') state.removed = true;
    state.row.revision++;
    return route.fulfill({ json: business(state) });
  });
}
