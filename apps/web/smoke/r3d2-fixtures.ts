import { IDP_OBJECTS } from '../../../packages/domain/src/idp/catalog.js';
import type { Page, Route } from '@playwright/test';
import { employee, snapshotFixture } from './fixtures.js';

// 全部为合成数据（AGENTS.md §5）；ID 不截断随机 UUID，固定写死便于断言。
export const planId = 'b0000000-0000-4000-8000-000000000001';
export const waitingId = 'b0000000-0000-4000-8000-000000000002';
export const templateId = 'b0000000-0000-4000-8000-000000000003';
export const processId = 'b0000000-0000-4000-8000-000000000004';
export const orgId = 'b0000000-0000-4000-8000-000000000005';
const moduleId = 'b0000000-0000-4000-8000-000000000006';
const subProcessId = 'b0000000-0000-4000-8000-000000000007';
export const goalModuleId = 'b0000000-0000-4000-8000-000000000008';
const analysisModuleId = 'b0000000-0000-4000-8000-000000000009';
const reviewModuleId = 'b0000000-0000-4000-8000-00000000000a';
const approvalId = 'b0000000-0000-4000-8000-00000000000b';
export const goalId = 'b0000000-0000-4000-8000-000000000201';
export const taskId = 'b0000000-0000-4000-8000-000000000202';
export const otherPlanId = 'b0000000-0000-4000-8000-000000000011';
export const otherEmployee = '30000000-0000-4000-8000-000000000002';

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
const stages = [stage(1, '制定计划', 'running'), stage(2, '中期回顾', 'pending')];
/** 列表行：真实列表接口不返回 currentNodeName（plan-routes summaries），夹具与之一致。 */
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
  stages,
};
const GOAL_BUTTONS = ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'];
function planDetail(buttons: string[]) {
  return {
    ...plan,
    currentNodeName: '制定发展目标',
    modules: [
      { id: moduleId, moduleType: 'basic', name: '基本信息', displayOrder: 0, buttons: [] },
      { id: goalModuleId, moduleType: 'goal', name: '发展目标', displayOrder: 1, buttons },
      { id: analysisModuleId, moduleType: 'analysis', name: '综述', displayOrder: 2, buttons: [] },
      { id: reviewModuleId, moduleType: 'review', name: '中期回顾', displayOrder: 3, buttons: [] },
    ],
    goals: [
      {
        id: goalId,
        moduleId: goalModuleId,
        name: '合成发展目标',
        measure: '完成合成课程',
        suggestion: null,
        startDate: '2026-10-01',
        endDate: '2026-11-30',
        sourceType: 'custom',
        displayOrder: 0,
        tasks: [{ id: taskId, name: '合成任务', description: null, startDate: '2026-10-02', endDate: null }],
        reviews: [],
      },
    ],
    analyses: [{ moduleId: analysisModuleId, currentAnalysis: '合成现状分析', developmentItems: '合成待发展项' }],
    reviews: [
      { moduleId: reviewModuleId, stageId: stages[0]!.id, summary: '合成阶段总结', improvement: '合成改进方法' },
    ],
    keyInfo: { tutorships: [], careers: [], workShifts: [] },
  };
}
const waiting = { ...plan, id: waitingId, revision: 1, name: '合成未开始计划', status: 'not_started', stages: [] };
/** 我的发展计划接口同时返回本人计划与作为指导人参与的他人计划（plan-routes my-plans）。 */
const participating = {
  ...plan,
  id: otherPlanId,
  name: '合成参与计划',
  employeeId: otherEmployee,
  tutorEmployeeId: undefined,
  tutorRole: undefined,
  processId: undefined,
};
function participantRow(row: typeof plan | typeof participating) {
  const { tutorRole: _r, tutorEmployeeId: _t, processId: _p, ...rest } = row;
  return rest;
}
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
  modules: [
    {
      id: moduleId,
      moduleType: 'goal',
      name: '发展目标',
      description: '合成目标模块说明',
      displayOrder: 0,
      allowCustomGoal: true,
      allowLibraryGoal: false,
      competencySource: 'current_position',
      goalReviewEnabled: true,
      taskEnabled: true,
      checkNoneGoal: false,
      nodeSettings: [{ subProcessId, nodeKey: 'n1', enabled: true, buttons: ['RowAddIdpGoal', 'RowEditIdpGoal'] }],
    },
    {
      id: goalModuleId,
      moduleType: 'key_info',
      name: '关键信息',
      description: null,
      displayOrder: 1,
      keyInfoSources: ['work_shift'],
      keyInfoBlocks: [{ block: 'work_shift', fields: ['orgId', 'startDate'] }],
    },
  ],
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
      name: '合成制定阶段',
      category: 'plan',
      approvalType: 'idp_plan',
      approvalProcessId: approvalId,
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
export interface IdpCall {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
  revision: string | null;
}
export interface IdpMockOptions {
  hasDataPermission?: boolean;
  /** 按对象覆盖可见 / 可编辑字段，模拟服务端字段裁剪；列表行同步去掉不可见字段。 */
  fields?: Record<string, { viewable?: string[]; editable?: string[] }>;
  /** 计划详情里目标模块的节点按钮（参与人视图）；HR 视图传空数组。 */
  goalButtons?: string[];
  /** 写接口的响应状态（如 500 模拟结果未知）。 */
  writeStatus?: number;
}

function objectPermission(code: string, options: IdpMockOptions) {
  const object = Object.values(IDP_OBJECTS).find((item) => item.code === code)!;
  const fields = object.fields.map((field) => field.code);
  const override = options.fields?.[code];
  const viewable = override?.viewable ?? fields;
  return {
    objectCode: code,
    dataOperations: { view: true },
    viewableFields: viewable,
    editableFields:
      override?.editable ?? viewable.filter((field) => !object.fields.find((item) => item.code === field)?.system),
    buttons: object.buttons.map((button) => ({ buttonCode: button.code, level: levels[button.code] ?? 'detail' })),
  };
}
/** 服务端按字段权限裁剪：对象目录里有、但不可见的键不输出。 */
function trim<T extends object>(code: string, row: T, options: IdpMockOptions): T {
  const viewable = options.fields?.[code]?.viewable;
  if (!viewable) return row;
  const known = Object.values(IDP_OBJECTS)
    .find((item) => item.code === code)!
    .fields.map((field) => field.code);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.includes(key) || viewable.includes(key))) as T;
}

/** 让演示身份看到 IDP 全部对象并按目录给出字段与按钮；返回记录到的 IDP 请求，供断言写请求次数与幂等键。 */
export async function mockIdp(page: Page, options: IdpMockOptions = {}) {
  const calls: IdpCall[] = [];
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
    return route.fulfill({ json: objectPermission(code, options) });
  });
  const scoped = options.hasDataPermission ?? true;
  const list = (items: unknown[]) => ({
    page: 1,
    pageSize: 200,
    hasDataPermission: scoped,
    items: scoped ? items : [],
  });
  const detail = planDetail(options.goalButtons ?? GOAL_BUTTONS);
  const reads: Record<string, unknown> = {
    '/plans': list([plan, waiting].map((row) => trim('IDP.Idp', row, options))),
    // 参与人列表固定字段：不含指导人角色、指导人与流程（plan-routes my-plans）
    '/my-plans': { page: 1, pageSize: 200, items: [plan, participating].map(participantRow) },
    [`/plans/${planId}`]: detail,
    [`/plans/${waitingId}`]: { ...detail, ...waiting },
    [`/plans/${otherPlanId}`]: { ...detail, ...participating },
    '/templates': list([trim('IDP.IDPTemplate', template, options)]),
    [`/templates/${templateId}`]: template,
    '/processes': list([process]),
    [`/processes/${processId}`]: process,
    '/approval-processes': {
      items: [
        {
          id: approvalId,
          name: '合成审批流程',
          approvalType: 'idp_plan',
          nodes: [{ nodeKey: 'n1', name: '制定发展目标', seq: 1 }],
        },
      ],
    },
  };
  const write = (route: Route, path: string) => {
    if (options.writeStatus) return route.fulfill({ status: options.writeStatus, json: { code: 'INTERNAL' } });
    if (path.includes('/tasks')) return route.fulfill({ status: path.endsWith('/tasks') ? 201 : 200, json: detail });
    if (path.endsWith('/copy')) return route.fulfill({ status: 201, json: { ...template, id: approvalId } });
    return route.fulfill({ json: path.startsWith('/plans') ? detail : template });
  };
  await page.route('**/api/tenant/idp/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/tenant\/idp/, '');
    if (request.method() !== 'GET') {
      calls.push({
        method: request.method(),
        path,
        body: request.postData() ? request.postDataJSON() : null,
        key: request.headers()['idempotency-key'] ?? null,
        revision: request.headers()['if-match'] ?? null,
      });
      return write(route, path);
    }
    return route.fulfill({ json: reads[path] ?? list([]) });
  });
  await mockNames(page);
  return calls;
}

/** 名称回查与候选列表：员工 / 组织模块的读接口，返回合成名称。 */
async function mockNames(page: Page) {
  const names: Record<string, string> = {
    [employee]: '合成员工甲',
    [otherEmployee]: '合成员工乙',
    [orgId]: '合成研发部',
  };
  await page.route(/\/api\/tenant\/(employment\/employees|org\/organizations)\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    return names[id] ? route.fulfill({ json: { id, name: names[id] } }) : route.fulfill({ status: 404, json: {} });
  });
  // 候选列表：员工 / 组织选择器的分页读取
  const choices = (ids: string[]) => ({ page: 1, pageSize: 20, items: ids.map((id) => ({ id, name: names[id] })) });
  await page.route(/\/api\/tenant\/employment\/employees(\?.*)?$/, (route) =>
    route.fulfill({ json: choices([employee, otherEmployee]) }),
  );
  await page.route(/\/api\/tenant\/org\/organizations(\?.*)?$/, (route) => route.fulfill({ json: choices([orgId]) }));
}
