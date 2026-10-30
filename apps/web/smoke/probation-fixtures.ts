import type { Page, Request } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';

// 形态对照 probation-routes.ts：视图行 = ProbationViewItem 裁剪后平铺（id 为当前主职任职记录，revision 为员工 revision）；
// GET /employees/:id/probation = probationDetail；PUT 回执去掉 records / recordId / entryDate；
// POST /regularizations = regularization.ts 逐人回执；建草稿 / 提交 / 读单据 = types.ts EmploymentBusiness。
export const department = '60000000-0000-4000-8000-000000000021';
export const recordId = '40000000-0000-4000-8000-000000000021';
export const businessId = '80000000-0000-4000-8000-000000000021';
export const assessmentId = '90000000-0000-4000-8000-000000000021';
export const person = { name: '合成试用员工', code: 'PB-DEMO-001' };

export interface Business {
  revision: number;
  status: string;
  mode: 'direct' | 'application';
  effectiveDate: string;
  probationResult: string;
}
/** 可变的“服务端状态”：写接口改它，列表、详情与写后回读都按它返回。 */
export interface Server {
  employeeRevision: number;
  probation: { hasProbation: boolean; startDate: string | null; months: number | null; expectedEndDate: string | null };
  regularizationDate: string | null;
  business?: Business;
  writes: { method: string; path: string; body: Record<string, unknown>; ifMatch?: string }[];
}

const posted = (request: Request) => ({
  method: request.method(),
  path: new URL(request.url()).pathname,
  body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
  ifMatch: request.headers()['if-match'],
});

function info(server: Server) {
  const business = server.business;
  return {
    employeeId: employee,
    revision: server.employeeRevision,
    ...server.probation,
    regularizationDate: business?.effectiveDate ?? server.regularizationDate,
    actualEndDate: null,
    regularizationBusinessId: business ? businessId : null,
    regularizationState: business?.status ?? null,
    regularizationMode: business?.mode ?? null,
    probationResult: business?.probationResult ?? null,
  };
}
function row(server: Server, assessing: boolean) {
  const { actualEndDate: _actual, ...controls } = info(server);
  return {
    id: recordId,
    ...controls,
    departmentId: department,
    postId: null,
    employeeStatus: 2,
    organizationId: department,
    ...person,
    assessmentId: assessing ? assessmentId : null,
    assessmentType: assessing ? 'probation_assessment' : null,
  };
}
/** 视图归属（PB-R1）：无转正业务在即将到期与全部；审批中在转正审批中与全部；审批通过 / 生效在已转正。 */
function inView(view: string, server: Server) {
  const state = server.business?.status;
  if (view === 'assessing') return true;
  if (view === 'regularized') return state === 'approved' || state === 'effective';
  if (view === 'in_review') return state === 'in_review';
  if (view === 'expiring') return !state || state === 'draft';
  return state !== 'approved' && state !== 'effective';
}
function business(server: Server) {
  const current = server.business!;
  return {
    id: businessId,
    employeeId: employee,
    revision: current.revision,
    employeeRevision: server.employeeRevision,
    status: current.status,
    kind: 'regularization',
    changeType: 'regularization',
    mode: current.mode,
    formId: 'standard',
    effectiveDate: current.effectiveDate,
    probation: false,
    probationMonths: null,
    probationEndDate: null,
    fields: { departmentId: department },
    customFields: {},
    employeeStatus: current.status === 'effective' ? 1 : 2,
    entryStatus: null,
    record: null,
    activation: null,
  };
}

export const allButtons = [
  'Employment.Edit',
  'Employment.Create',
  'Employment.Submit',
  'Employment.Withdraw',
  'Employment.Revoke',
];
async function routePermissions(page: Page, buttons: string[]) {
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
        viewableFields: ['name', 'code', 'departmentId', 'postId', 'effectiveDate'],
        editableFields: ['departmentId', 'effectiveDate'],
        buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    }),
  );
}

export async function setup(page: Page, options: { buttons?: string[] } = {}) {
  const queries: URLSearchParams[] = [];
  const server: Server = {
    employeeRevision: 4,
    probation: { hasProbation: true, startDate: '2026-08-01', months: 3, expectedEndDate: '2026-10-31' },
    regularizationDate: null,
    writes: [],
  };
  await routePermissions(page, options.buttons ?? allButtons);
  await page.route('**/employment/probation-views?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const view = query.get('view') ?? 'expiring';
    return route.fulfill({
      json: {
        items: inView(view, server) ? [row(server, view === 'assessing')] : [],
        page: Number(query.get('page')),
        pageSize: Number(query.get('pageSize')),
        hasDataPermission: true,
      },
    });
  });
  await page.route('**/employment/probation-results?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'a0000000-0000-4000-8000-000000000001',
            code: 'pass',
            name: '合成通过',
            enabled: true,
            displayOrder: 0,
          },
        ],
      },
    }),
  );
  await page.route(/\/org\/organizations(\/[^/?]+)?(\?.*)?$/, (route) =>
    route.fulfill({
      json: route.request().url().includes('?')
        ? { items: [{ id: department, name: '合成试用部门' }] }
        : { id: department, name: '合成试用部门' },
    }),
  );
  await page.route(`**/personnel/employees/${employee}`, (route) =>
    route.fulfill({ json: { id: employee, ...person, revision: 1 } }),
  );
  await page.route(`**/employment/probation-assessments/${assessmentId}`, (route) =>
    route.fulfill({
      json: {
        id: assessmentId,
        employeeId: employee,
        assessmentType: 'probation_assessment',
        assessmentName: '合成试用中考核',
        assessmentDate: '2026-10-20',
        selfEvaluation: '合成自评',
        managerRating: 'meets',
        regularizationOpinion: 'normal',
        regularizationDate: null,
        status: 'in_review',
        revision: 2,
      },
    }),
  );
  await routeWrites(page, server);
  await page.goto('/probations');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/probations');
  return { queries, server };
}

async function routeWrites(page: Page, server: Server) {
  await page.route(`**/employment/employees/${employee}`, (route) =>
    route.fulfill({ json: { id: employee, ...person, revision: server.employeeRevision } }),
  );
  await page.route(`**/employment/employees/${employee}/probation*`, (route) => {
    if (route.request().method() !== 'PUT')
      return route.fulfill({
        json: { ...info(server), recordId, entryDate: '2026-08-01', records: [] },
      });
    const write = posted(route.request());
    server.writes.push(write);
    const { regularizationDate, ...probation } = write.body as Partial<Server['probation']> & {
      hasProbation: boolean;
      regularizationDate?: string;
    };
    server.probation = { startDate: null, months: null, expectedEndDate: null, ...probation };
    server.regularizationDate = regularizationDate ?? null;
    server.employeeRevision += 1;
    return route.fulfill({ json: info(server) });
  });
  await page.route('**/employment/regularizations', (route) => {
    const write = posted(route.request());
    server.writes.push(write);
    const effectiveDate = String(write.body.effectiveDate ?? '2026-11-01');
    server.business = {
      revision: 1,
      status: 'approved',
      mode: 'direct',
      effectiveDate,
      probationResult: String(write.body.probationResult),
    };
    server.employeeRevision += 1;
    return route.fulfill({
      json: {
        total: 1,
        succeeded: 1,
        failed: 0,
        items: [
          {
            employeeId: employee,
            status: 'succeeded',
            businessId,
            effectiveDate,
            businessStatus: 'approved',
            error: null,
          },
        ],
      },
    });
  });
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    const write = posted(route.request());
    server.writes.push(write);
    server.business = {
      revision: 1,
      status: 'draft',
      mode: 'application',
      effectiveDate: String(write.body.effectiveDate),
      probationResult: String(write.body.probationResult),
    };
    server.employeeRevision += 1;
    return route.fulfill({ status: 201, json: business(server) });
  });
  await page.route(`**/employment/businesses/${businessId}`, (route) => route.fulfill({ json: business(server) }));
  await page.route(`**/employment/businesses/${businessId}/submit`, (route) => {
    server.writes.push(posted(route.request()));
    server.business = { ...server.business!, status: 'in_review', revision: server.business!.revision + 1 };
    return route.fulfill({ json: business(server) });
  });
}

const labels: Record<string, string> = {
  expiring: '即将试用到期',
  assessing: '考核中',
  in_review: '转正审批中',
  all: '全部试用员工',
  regularized: '已转正',
};
/** 切到某视图并等该视图的列表返回（切换后再点，确保点到的是本视图的行）。 */
export async function switchView(page: Page, view: string) {
  const button = page.getByRole('button', { name: labels[view], exact: true });
  if ((await button.getAttribute('aria-pressed')) === 'true') return;
  const loaded = page.waitForResponse((response) => response.url().includes(`view=${view}`));
  await button.click();
  await loaded;
}
export async function openDetail(page: Page) {
  await page
    .locator('.probation-table tr.ant-table-row')
    .first()
    .getByRole('button', { name: '查看详情', exact: true })
    .click();
  await page.getByRole('heading', { name: person.name, exact: true }).waitFor();
}
