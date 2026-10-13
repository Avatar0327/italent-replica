import { EVALUATION_OBJECTS } from '../../../packages/domain/src/evaluation/catalog.js';
import { EVALUATION_FLOW_OBJECTS } from '../../../packages/domain/src/evaluation/flow-catalog.js';
import { SURVEY360_OBJECTS } from '../../../packages/domain/src/survey360/catalog.js';
import type { Page } from '@playwright/test';
import { tenant, user } from './fixtures.js';
export const id = '40000000-0000-4000-8000-000000000001';
export const ev = {
  id,
  revision: 2,
  name: '合成年度评定',
  status: 'draft',
  year: 2026,
  applyCount: 0,
  typeId: id,
  cycleId: id,
  ownerOrgId: id,
  managerEmployeeId: id,
  manager: { name: '合成负责人' },
  startDate: '2026-10-01',
  endDate: '2026-10-31',
  effectiveDate: '2026-10-31',
  applicants: ['self'],
  orgRange: [{ orgId: id, includeDescendants: false }],
  categoryIds: [id],
  levelIds: [id],
  maxLevelJump: 1,
  conditions: [],
  chains: [
    {
      id: 'chain-apply',
      type: 'apply',
      name: '资格申报',
      startDate: '2026-10-01',
      endDate: '2026-10-20',
      approvalProcessCode: 'DEMO-APPLY',
      transferMode: 'auto',
    },
    {
      id: 'chain-result',
      type: 'result',
      name: '结果发布',
      startDate: '2026-10-21',
      endDate: '2026-10-31',
      transferMode: 'manual',
    },
  ],
};
export const activity = {
  id,
  revision: 3,
  name: '合成领导力评估',
  scene: '人才盘点',
  form: 'multiple',
  status: 'draft',
  welcome: '欢迎参与合成评估',
  showAppraiserName: true,
  roleDisplay: 'name',
};
export const questionnaire = {
  id,
  revision: 2,
  name: '合成协作套卷',
  type: 'key_behavior',
  status: 'enabled',
  scoreMethod: 'weighted_average',
  guide: '请选择最符合的选项',
  roles: [{ key: 'peer', roleId: id, weight: 1 }],
  scales: [{ id: 'scale', key: 'scale', name: '五分量表', options: [{ key: 'yes', label: '符合', value: 5 }] }],
  dimensions: [{ id: 'dimension', key: 'team', name: '团队协作', weight: 100, scaleId: 'scale', parentId: null }],
  questions: [
    { id: 'question', key: 'q', dimensionId: 'dimension', scaleId: 'scale', text: '主动共享信息', weight: 1 },
  ],
};
export async function setupR3b(page: Page, path: string, readonly = false) {
  const objects = [
    ...Object.values(EVALUATION_OBJECTS),
    ...Object.values(EVALUATION_FLOW_OBJECTS),
    ...Object.values(SURVEY360_OBJECTS),
  ];
  await page.route('**/__demo/personas', (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        current: null,
        personas: [{ userId: user, name: '合成演示用户', role: '演示身份', entry: path }],
      },
    }),
  );
  await page.route('**/permission/me/objects/*', (route) => {
    const object = objects.find((o) => route.request().url().endsWith(o.code));
    return route.fulfill({
      json: {
        objectCode: object?.code,
        dataOperations: { read: true },
        viewableFields: object?.fields.filter((f) => !readonly || f.code !== 'year').map((f) => f.code) ?? ['name'],
        editableFields: readonly ? [] : (object?.fields.filter((f) => !f.system).map((f) => f.code) ?? []),
        buttons: readonly ? [] : (object?.buttons.map((b) => ({ buttonCode: b.code, level: b.level })) ?? []),
      },
    });
  });
  await page.route('**/api/tenant/evaluation/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = evaluationFixture(pathname);
    return route.fulfill({ json: body });
  });
  await page.route('**/api/tenant/survey360/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = surveyFixture(pathname);
    return route.fulfill({ json: body });
  });
  await page.goto(path);
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL(`**${path}`);
}

function evaluationFixture(pathname: string) {
  if (pathname.endsWith(`/activities/${id}`)) return ev;
  if (pathname.endsWith('/activities')) return { items: [ev] };
  if (pathname.endsWith('/staff-evaluations'))
    return { items: [{ id, revision: 1, employeeId: id, currentStage: 'apply' }], total: 1 };
  return { items: [{ id, name: '合成候选', enabled: true }] };
}
function surveyFixture(pathname: string) {
  if (pathname.endsWith(`/activities/${id}`)) return activity;
  if (pathname.endsWith('/activities')) return { items: [activity] };
  if (/\/(questionnaires|templates)$/.test(pathname)) return { items: [questionnaire] };
  if (/\/(questionnaires|templates)\/[^/]+$/.test(pathname)) return questionnaire;
  if (pathname.endsWith('/objects'))
    return { items: [{ id, revision: 1, person: { name: '合成参评人' }, questionnaireIds: [id] }] };
  if (pathname.endsWith('/appraisers')) return { items: [{ id, appraiser: { name: '合成评价者' }, roleName: '同事' }] };
  return { items: [{ id, name: '合成候选' }] };
}
