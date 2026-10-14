import { IDP_OBJECTS } from '../../../packages/domain/src/idp/catalog.js';
import type { Page } from '@playwright/test';
import { employee, snapshotFixture } from './fixtures.js';

// 全部为合成数据（AGENTS.md §5）；ID 不截断随机 UUID，固定写死便于断言。
export const planId = 'b0000000-0000-4000-8000-000000000001';
export const waitingId = 'b0000000-0000-4000-8000-000000000002';
export const templateId = 'b0000000-0000-4000-8000-000000000003';
export const processId = 'b0000000-0000-4000-8000-000000000004';
export const orgId = 'b0000000-0000-4000-8000-000000000005';
const moduleId = 'b0000000-0000-4000-8000-000000000006';
const subProcessId = 'b0000000-0000-4000-8000-000000000007';

const stage = (seq: number, name: string, status: string) => ({
  id: `b0000000-0000-4000-8000-00000000010${seq}`,
  subProcessId,
  seq,
  name,
  status,
  approvalInstanceId: null,
  dueDate: '2026-10-01',
  endedOn: null,
  failureReason: null,
  attemptCount: 0,
});
export const plan = {
  id: planId,
  revision: 3,
  name: '合成发展计划',
  employeeId: employee,
  templateId,
  processId,
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  tutorRole: 'direct_manager',
  tutorEmployeeId: employee,
  status: 'running',
  currentStageName: '制定计划',
  currentNodeName: '制定发展目标',
  stages: [stage(1, '制定计划', 'running'), stage(2, '中期回顾', 'pending')],
  modules: [
    { id: moduleId, moduleType: 'basic', name: '基本信息', description: null, displayOrder: 0 },
    { id: `${moduleId.slice(0, -1)}8`, moduleType: 'goal', name: '发展目标', description: null, displayOrder: 1 },
  ],
  goals: [
    {
      id: 'b0000000-0000-4000-8000-000000000201',
      moduleId: `${moduleId.slice(0, -1)}8`,
      name: '合成发展目标',
      measure: '完成合成课程',
      suggestion: null,
      startDate: '2026-10-01',
      endDate: '2026-11-30',
      sourceType: 'custom',
      displayOrder: 0,
      tasks: [{ id: 'b0000000-0000-4000-8000-000000000202', name: '合成任务', startDate: '2026-10-02' }],
      reviews: [],
    },
  ],
  analyses: [],
  reviews: [],
  keyInfo: { tutorships: [], careers: [], workShifts: [] },
};
const waiting = { ...plan, id: waitingId, revision: 1, name: '合成未开始计划', status: 'not_started', stages: [] };
export const template = {
  id: templateId,
  revision: 2,
  name: '合成发展计划模板',
  description: '合成说明',
  orgId,
  publicDown: true,
  processId,
  status: 'published',
  referenced: true,
  modules: plan.modules,
  commonGoals: [],
};
export const process = {
  id: processId,
  revision: 1,
  name: '合成发展计划流程',
  orgId,
  publicDown: false,
  enabled: true,
  referenced: false,
  subProcesses: [
    {
      id: subProcessId,
      seq: 1,
      name: '制定计划',
      category: 'plan',
      approvalType: 'idp_plan',
      approvalProcessId: orgId,
      startMode: 'auto',
      startTimeType: null,
      fixedDate: null,
      referencePoint: null,
      startFrom: null,
      days: null,
    },
  ],
};

const levels: Record<string, string> = {
  create: 'list',
  urge: 'list',
  startNext: 'list',
  terminate: 'list',
  issue: 'list',
};
/** 让演示身份看到 IDP 全部对象，并按目录给出全部字段与按钮。 */
export async function mockIdp(page: Page, options: { hasDataPermission?: boolean } = {}) {
  const codes = Object.values(IDP_OBJECTS).map((object) => object.code);
  await page.route('**/api/tenant/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'idp' ? { ...app, entryObjects: codes } : app)),
      },
    }),
  );
  await page.route('**/permission/me/objects/IDP.*', (route) => {
    const code = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const object = Object.values(IDP_OBJECTS).find((item) => item.code === code)!;
    const fields = object.fields.map((field) => field.code);
    return route.fulfill({
      json: {
        objectCode: code,
        dataOperations: { view: true },
        viewableFields: fields,
        editableFields: fields.filter((field) => !object.fields.find((item) => item.code === field)?.system),
        buttons: object.buttons.map((button) => ({
          buttonCode: button.code,
          level: levels[button.code] ?? 'detail',
        })),
      },
    });
  });
  const scoped = options.hasDataPermission ?? true;
  const list = (items: unknown[]) => ({ page: 1, pageSize: 200, hasDataPermission: scoped, items: scoped ? items : [] });
  await page.route('**/api/tenant/idp/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/tenant\/idp/, '');
    const bodies: Record<string, unknown> = {
      '/plans': list([plan, waiting]),
      '/my-plans': { page: 1, pageSize: 200, items: [plan] },
      [`/plans/${planId}`]: plan,
      [`/plans/${waitingId}`]: waiting,
      '/templates': list([template]),
      [`/templates/${templateId}`]: template,
      '/processes': list([process]),
      [`/processes/${processId}`]: process,
      '/approval-processes': { items: [{ id: orgId, name: '合成审批流程', nodes: [] }] },
    };
    return route.fulfill({ json: bodies[path] ?? list([]) });
  });
}
