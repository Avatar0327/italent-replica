import type { Page } from '@playwright/test';
import { snapshotFixture } from './fixtures.js';

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
const positionMap = {
  asOf: '2026-10-13',
  hasDataPermission: true,
  roots: [ids.position],
  items: [
    {
      id: ids.position,
      name: '合成研发总监',
      orgId: ids.org,
      parentId: null,
      incumbents: [person],
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
  rules: [],
  warnings: [],
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

function body(path: string, search: URLSearchParams): unknown {
  const tail = path.replace(/^.*\/api\/tenant\/succession/, '');
  if (tail === '/records') {
    const item = search.get('successionType') === 'org' ? orgRecord : positionRecord;
    return { page: 1, pageSize: 15, total: 1, asOf: '2026-10-13', hasDataPermission: true, items: [item] };
  }
  if (tail === `/records/${ids.record}`) return positionRecord;
  if (tail === `/records/${ids.orgRecord}`) return orgRecord;
  if (tail === '/readiness') return { items: [readiness] };
  if (tail === '/maps/position') return positionMap;
  if (tail === '/maps/org') return orgMap;
  if (tail === '/maps/position/preferences')
    return {
      id: ids.level,
      rootOrgId: null,
      depth: 3,
      hiddenOrgIds: [],
      showKeyPositions: false,
      showPositionsWithoutSuccessor: true,
      revision: 0,
    };
  if (/^\/(risk|health)-levels\/options$/.test(tail)) return { items: [level] };
  if (/^\/(risk|health)-levels$/.test(tail))
    return { page: 1, pageSize: 15, total: 1, collectionRevision: 1, items: [level] };
  if (/^\/rule-settings\//.test(tail)) return { defaultColor: '#7498FB', revision: 1 };
  return { items: [], total: 0, hasDataPermission: true };
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
    return route.fulfill({ json: body(url.pathname, url.searchParams) });
  });
  await page.route('**/api/tenant/talent-review/readiness-levels**', (route) =>
    route.fulfill({ json: { page: 1, pageSize: 15, total: 1, items: [readinessLevel] } }),
  );
}
