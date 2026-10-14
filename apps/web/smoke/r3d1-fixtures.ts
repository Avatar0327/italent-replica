import type { Locator, Page } from '@playwright/test';
import { expect, snapshotFixture, user } from './fixtures.js';

// FE-R3d-1 冒烟的合成数据：编号全为占位，人名为“合成××”，不含原站真实数据。
export const ids = {
  record: '50000000-0000-4000-8000-000000000001',
  orgRecord: '50000000-0000-4000-8000-000000000002',
  position: '51000000-0000-4000-8000-000000000001',
  childPosition: '51000000-0000-4000-8000-000000000002',
  org: '52000000-0000-4000-8000-000000000001',
  childOrg: '52000000-0000-4000-8000-000000000002',
  employee: '53000000-0000-4000-8000-000000000001',
  readiness: '54000000-0000-4000-8000-000000000001',
  level: '55000000-0000-4000-8000-000000000001',
  keyPosition: '51000000-0000-4000-8000-000000000003',
  population: '56000000-0000-4000-8000-000000000001',
};
const person = { employeeId: ids.employee, name: '合成继任者', email: 'successor@example.com', label: '合成继任者' };
const readiness = { id: ids.readiness, code: 'READY_NOW', name: '随时可继任', color: '#2BA471' };
const common = {
  revision: 2,
  createdBy: ids.employee,
  createdAt: '2026-10-01T02:00:00Z',
  updatedAt: '2026-10-02T02:00:00Z',
  successorEmployeeId: ids.employee,
  readinessId: ids.readiness,
  backupType: 'principal',
  startDate: '2026-10-01',
  endDate: null,
  status: 'active',
  successor: person,
  successorLeft: false,
  readiness,
};
export const positionRecord = {
  ...common,
  id: ids.record,
  successionType: 'position',
  targetPositionId: ids.position,
  targetPosition: { id: ids.position, name: '合成研发总监', orgId: ids.org },
  incumbents: [{ ...person, employeeId: ids.org, name: '合成现任' }],
};
export const orgRecord = {
  ...common,
  id: ids.orgRecord,
  successionType: 'org',
  targetOrgId: ids.org,
  targetOrg: { id: ids.org, name: '合成研发中心' },
  personInCharge: { ...person, name: '合成负责人' },
};
const risk = {
  id: ids.level,
  positionId: ids.position,
  levelId: ids.level,
  levelName: '高风险',
  levelColor: '#E34D59',
};
const successors = [{ id: ids.record, successor: person, readiness, backupType: 'principal', startDate: '2026-10-01' }];
export const positionMap = {
  asOf: '2026-10-13',
  hasDataPermission: true,
  roots: [ids.position],
  items: [
    {
      id: ids.position,
      name: '合成研发总监',
      orgId: ids.org,
      parentId: null,
      incumbents: [{ ...person, employeeId: ids.org, name: '合成现任' }],
      successors,
      successorCount: 1,
      risk: { ...risk, revision: 1 },
    },
    { id: ids.childPosition, name: '合成架构师', orgId: ids.org, parentId: ids.position, incumbents: [] },
  ],
};
export const orgMap = {
  asOf: '2026-10-13',
  rootId: ids.org,
  depth: 3,
  hasDataPermission: true,
  items: [
    {
      id: ids.org,
      name: '合成研发中心',
      parentId: null,
      personInCharge: person,
      successors: [orgRecord],
      successorCount: 1,
      health: { id: ids.level, orgId: ids.org, levelId: ids.level, levelName: '健康', levelColor: '#2BA471' },
      stats: { onDutyCount: 12, greenRate: 0.5, capacity: '--', statDate: '2026-10-12' },
      keyPositions: [
        {
          id: ids.keyPosition,
          name: '合成关键职位',
          parentId: ids.org,
          incumbents: [],
          successorCount: 0,
          risk: { ...risk, positionId: ids.keyPosition, revision: 1 },
        },
      ],
    },
    { id: ids.childOrg, name: '合成测试部', parentId: ids.org },
  ],
};
const level = {
  id: ids.level,
  code: 'HIGH',
  name: '高风险',
  color: '#E34D59',
  description: '合成说明',
  enabled: true,
  displayOrder: 1,
  revision: 1,
  compileError: null,
  rules: {
    expression: '1 and 2',
    rows: [
      { rowNo: 1, subject: 'incumbent', measure: 'count', comparator: 'eq', threshold: 0, isPercent: false },
      { rowNo: 2, subject: 'successor', measure: 'count', comparator: 'lt', threshold: 2, isPercent: false },
    ],
  },
  warnings: [],
};
const population = {
  id: ids.population,
  code: 'YOUNG',
  name: '合成青年人才',
  displayOrder: 1,
  revision: 1,
  rules: { expression: '1', rows: [{ rowNo: 1, field: { code: 'age', label: '年龄' }, operator: 'lt', values: [45] }] },
};
// 偏好接口的真实回执不带 id（map-routes.ts PUT /maps/:kind/preferences）。
export const preferences = {
  rootOrgId: null,
  depth: 3,
  hiddenOrgIds: [],
  showKeyPositions: false,
  showPositionsWithoutSuccessor: true,
  revision: 0,
};
const readinessLevel = { ...readiness, description: '合成说明', sortNo: 1, enabled: true, revision: 1 };

const recordFields = [
  'successionType',
  'targetOrgId',
  'targetPositionId',
  'successorEmployeeId',
  'readinessId',
  'backupType',
  'startDate',
  'endDate',
  'endReason',
  'status',
  'incumbents',
  'personInCharge',
  'createdAt',
  'updatedAt',
  'createdBy',
];
const objectFields: Record<string, string[]> = {
  'Succession.Record': recordFields,
  'Succession.Map': ['successors', 'successorCount', 'stats', 'keyPositions'],
  'Succession.RiskResult': ['levelId'],
  'Succession.HealthResult': ['levelId'],
  'Succession.RiskLevel': ['code', 'name', 'color', 'description', 'displayOrder', 'enabled', 'rules'],
  'Succession.HealthLevel': ['code', 'name', 'color', 'description', 'displayOrder', 'enabled', 'rules'],
  'Succession.Population': ['code', 'name', 'displayOrder', 'rules'],
  'Succession.RuleSettings': ['defaultColor'],
  'TalentReview.Readiness': ['code', 'name', 'description', 'color', 'sortNo', 'enabled'],
};
const objectButtons: Record<string, [string, string][]> = {
  'Succession.Record': [
    ['create', 'list'],
    ['end', 'list'],
    ['update', 'detail'],
    ['delete', 'detail'],
  ],
  'Succession.Map': [
    ['computeRisk', 'list'],
    ['computeHealth', 'list'],
    ['computeStats', 'list'],
  ],
  'Succession.RiskResult': [['assign', 'detail']],
  'Succession.HealthResult': [['assign', 'detail']],
  'Succession.RiskLevel': [
    ['create', 'list'],
    ['update', 'detail'],
    ['delete', 'detail'],
  ],
  'Succession.HealthLevel': [['create', 'list']],
  'TalentReview.Readiness': [
    ['create', 'list'],
    ['update', 'detail'],
    ['delete', 'detail'],
  ],
};

function read(tail: string, search: URLSearchParams): unknown {
  if (tail === '/records') {
    const item = search.get('successionType') === 'org' ? orgRecord : positionRecord;
    return { page: 1, pageSize: 15, total: 1, asOf: '2026-10-13', hasDataPermission: true, items: [item] };
  }
  if (tail === `/records/${ids.record}`) return positionRecord;
  if (tail === `/records/${ids.orgRecord}`) return orgRecord;
  if (tail === '/readiness') return { items: [readiness] };
  if (tail === '/maps/position') return positionMap;
  if (tail === '/maps/org') return orgMap;
  if (tail === '/maps/position/preferences') return preferences;
  if (tail === '/populations') return { page: 1, pageSize: 15, total: 1, items: [population] };
  if (/^\/(risk|health)-levels\/options$/.test(tail)) return { items: [level] };
  if (/^\/(risk|health)-levels$/.test(tail))
    return { page: 1, pageSize: 15, total: 1, collectionRevision: 1, items: [level] };
  if (/^\/rule-settings\//.test(tail)) return { defaultColor: '#7498FB', revision: 1 };
  return { items: [], total: 0, hasDataPermission: true };
}
/** 写接口按真实回执形状返回：批量结束 {items}、偏好不带 id、等级赋值带结果行 id。 */
function write(tail: string, payload: Record<string, unknown>): unknown {
  if (tail === '/records/end') return { items: [{ ...positionRecord, status: 'ended', revision: 3 }] };
  if (tail === '/maps/position/preferences') return { ...preferences, ...payload, revision: preferences.revision + 1 };
  const assigned = /^\/(risk|health)-results\/(.+)$/.exec(tail);
  if (assigned) return { id: assigned[2], levelId: payload.levelId ?? null, revision: 2 };
  return read(tail, new URLSearchParams());
}

export async function mockSuccession(page: Page) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => {
          if (app.app === 'succession')
            return { ...app, entryObjects: Object.keys(objectFields).filter((code) => code.startsWith('Succession.')) };
          if (app.app === 'talent-review')
            return { ...app, entryObjects: [...app.entryObjects, 'TalentReview.Readiness'] };
          return app;
        }),
      },
    }),
  );
  await page.route(/\/permission\/me\/objects\/(Succession|TalentReview)\./, (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const fields = objectFields[objectCode] ?? ['name'];
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { view: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: (objectButtons[objectCode] ?? []).map(([buttonCode, level]) => ({ buttonCode, level })),
      },
    });
  });
  await page.route('**/api/tenant/succession/**', (route) => {
    const url = new URL(route.request().url());
    const tail = url.pathname.replace(/^.*\/api\/tenant\/succession/, '');
    const method = route.request().method();
    const json = method === 'GET' ? read(tail, url.searchParams) : write(tail, route.request().postDataJSON() ?? {});
    return route.fulfill({ json });
  });
  // 准备度接口没有 total（人才盘点 readiness-levels）：满页时才可能有下一页。
  await page.route('**/api/tenant/talent-review/readiness-levels**', (route) =>
    route.fulfill({ json: { page: 1, pageSize: 15, items: [readinessLevel] } }),
  );
  await page.route('**/api/tenant/org/organizations**', (route) =>
    route.fulfill({
      json: {
        page: 1,
        pageSize: 200,
        total: 2,
        items: [
          { id: ids.org, name: '合成研发中心' },
          { id: ids.childOrg, name: '合成测试部' },
        ],
      },
    }),
  );
}

export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
// antd 会在两个汉字的按钮文字中间插空格（“新 建”），按钮名按字间可有空白匹配。
export const button = (page: Page | Locator, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${[...name].join('\\s*')}$`) });
/** 选好演示身份并等侧栏菜单就绪（明确的就绪条件），之后由调用方只导航一次。 */
export async function openShell(page: Page) {
  await page.goto('/succession');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole('menuitem', { name: '继任管理', exact: true })).toBeVisible();
}
export async function openMenu(page: Page, item: string) {
  await openShell(page);
  await page.getByRole('menuitem', { name: '继任管理', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
export const cancel = (page: Page) =>
  page
    .getByRole('button', { name: /取\s*消/ })
    .last()
    .click();
/** 覆盖某个权限对象的字段权限（后注册的路由优先）。 */
export async function objectAccess(page: Page, objectCode: string, viewable: string[], editable: string[]) {
  await page.route(`**/permission/me/objects/${objectCode}`, (route) =>
    route.fulfill({
      json: {
        objectCode,
        dataOperations: { view: true },
        viewableFields: viewable,
        editableFields: editable,
        buttons: (objectButtons[objectCode] ?? []).map(([buttonCode, level]) => ({ buttonCode, level })),
      },
    }),
  );
}
export { objectFields };
