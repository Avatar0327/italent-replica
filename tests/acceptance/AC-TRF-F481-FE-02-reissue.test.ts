/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-TRF-F481-FE-02（F-481 设计 §8.1、§12）：任职记录列表「调动发起电子签署」补发入口。
 * 不勾选 → “请至少选择一条数据”；勾选若干行选模板提交 → 逐条回执提示；无按钮权限时不显示；
 * 调动管理的同名菜单仍禁用（该列表仍是演示数据，DEC-456、DEC-774）。
 * 夹具形状按后端：列表行取 support/f474-records-row.ts（后端验收核对过键集）；模板选项、补发回执按
 * esign/task-routes.ts 与 reissue.ts：{ items: [{ id, ok:false, code } |
 * { id, ok:true, taskId, status, failureReason }] }。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORD_ROW } from './support/f474-records-row.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App, ConfigProvider } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { EmploymentRecordsPage } = await import(resolve('apps/web/src/employment-records/EmploymentRecordsPage.tsx'));
const pageModel = await import(resolve('apps/web/src/transfer/page-model.ts'));

const RECORD_OBJECT = 'TenantBase.EmploymentRecord';
const LIST = '/api/tenant/employment/records';
const OPTIONS = '/api/tenant/esign/template-options/reissue';
const TASKS = '/api/tenant/esign/transfer-tasks';
const T1 = '84810000-0000-4000-8000-000000000201';
const T2 = '84810000-0000-4000-8000-000000000202';
const LABEL = '调动发起电子签署';
const row = (suffix: string, employeeName: string, kind = 'transfer') => ({
  ...RECORD_ROW,
  id: `30000000-0000-4000-8000-0000000481${suffix}`,
  employeeId: `30000000-0000-4000-8000-0000000482${suffix}`,
  employeeCode: `SYN-481-${suffix}`,
  employeeName,
  kind,
});
const ROWS = [
  row('01', '合成员工甲'),
  row('02', '合成员工乙'),
  row('03', '合成员工丙', 'entry'),
  row('04', '合成员工丁'),
];
const fields = ['name', 'code', 'employeeStatus', 'isCurrent', 'serviceType', 'departmentId', 'email'];
const session = {
  tenantId: '10000000-0000-4000-8000-000000000481',
  userId: '20000000-0000-4000-8000-000000000481',
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
let buttons: { buttonCode: string; level: string }[];
let options: Reply;
let tasks: Reply[];
let posts: { body: unknown; key: string | null }[];
let optionReads: number;
function replyOf(url: URL, init: RequestInit): Reply {
  const path = url.pathname;
  if (path.endsWith('/me/snapshot')) return { body: { session, apps: [], scope: [], adminMenus: [] } };
  if (path.includes('/permission/me/objects/')) {
    const objectCode = decodeURIComponent(path.split('/').at(-1)!);
    return {
      body: {
        objectCode,
        dataOperations: { read: true, create: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: objectCode === RECORD_OBJECT ? buttons : [],
      },
    };
  }
  if (path === LIST) return { body: { items: ROWS, total: ROWS.length } };
  if (path === OPTIONS) {
    optionReads += 1;
    return options;
  }
  if (path === TASKS && init.method === 'POST') {
    posts.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('idempotency-key') });
    return tasks.shift() ?? { status: 500, body: {} };
  }
  return { body: { items: [], hasDataPermission: true } };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  buttons = [
    { buttonCode: 'update', level: 'detail' },
    { buttonCode: 'MulLaunchESignTranfer', level: 'list' },
  ];
  options = {
    body: {
      items: [
        { id: T1, name: '合成调动协议' },
        { id: T2, name: '合成保密协议' },
      ],
    },
  };
  tasks = [];
  posts = [];
  optionReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const reply = replyOf(new URL(String(raw), 'http://localhost'), init);
      return Response.json(reply.body, { status: reply.status ?? 200 });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const settle = (ms = 30) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function render() {
  const theme = { token: { motion: false } };
  const page = h(EmploymentRecordsPage);
  await act(async () =>
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/'] },
        h(SessionProvider, { session }, h(PermissionsProvider, {}, h(ConfigProvider, { theme }, h(App, {}, page)))),
      ),
    ),
  );
  await settle(60);
  expect(host.querySelectorAll('.ant-table-tbody .ant-table-row .ant-checkbox-input'), '列表已出现').toHaveLength(
    ROWS.length,
  );
}
async function click(element: Element | null | undefined) {
  expect(element, '可点击的元素').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}
const reissueButton = () =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.page-heading button')).find((item) =>
    item.textContent?.replace(/\s/g, '').includes(LABEL),
  );
const check = (...indexes: number[]) =>
  indexes.reduce<Promise<void>>(
    (chain, index) =>
      chain.then(() => click(host.querySelectorAll('.ant-table-tbody .ant-table-row .ant-checkbox-input')[index])),
    Promise.resolve(),
  );
const modal = () => document.querySelector<HTMLElement>('.ant-modal');
const templates = () => modal()?.querySelector<HTMLSelectElement>('select[name="esignTemplateIds"]');
async function pick(...ids: string[]) {
  const element = templates()!;
  await act(async () => {
    for (const option of Array.from(element.options)) option.selected = ids.includes(option.value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const modalButton = (label: string) =>
  Array.from(modal()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  );
const receipt = (index: number, extra: Record<string, unknown>) => ({ id: ROWS[index]!.id, ...extra });

describe('AC-TRF-F481-FE-02 任职记录列表：调动发起电子签署（补发）', () => {
  it('FE-02-01 不勾选点「调动发起电子签署」→ 提示“请至少选择一条数据”，不开弹窗、不读模板', async () => {
    await render();
    await click(reissueButton());
    expect(document.body.textContent).toContain('请至少选择一条数据');
    expect(modal()).toBeNull();
    expect(optionReads).toBe(0);
  });

  it('FE-02-02 勾 2 行选模板提交：报文为所勾行 + 所选模板，带命令 ID；按回执逐条显示中文结果', async () => {
    tasks = [
      {
        body: {
          items: [
            receipt(0, {
              ok: true,
              taskId: '84810000-0000-4000-8000-000000000301',
              status: 'signing',
              failureReason: null,
            }),
            receipt(1, { ok: false, code: 'ESIGN_TRANSFER_NOT_ACTIVE' }),
          ],
        },
      },
    ];
    await render();
    await check(0, 1);
    await click(reissueButton());
    expect(modal()?.textContent).toContain(LABEL);
    expect(Array.from(templates()!.options, (option) => option.textContent)).toEqual(['合成调动协议', '合成保密协议']);
    expect(modalButton('确定')?.disabled).toBe(true);
    await pick(T2);
    await click(modalButton('确定'));
    expect(posts).toEqual([
      {
        body: { items: [{ businessId: ROWS[0]!.id }, { businessId: ROWS[1]!.id }], templateIds: [T2] },
        key: expect.any(String),
      },
    ]);
    const text = modal()?.textContent ?? '';
    expect(text).toContain('合成员工甲');
    expect(text).toContain('已发起签署');
    expect(text).toContain('合成员工乙');
    expect(text).toContain('不可发起：调动尚未生效');
    expect(text).not.toMatch(/ESIGN_|NOT_FOUND|signing/);
  });

  it('FE-02-03 非调动行不预先过滤；发起失败带原因文案；不可发起分别说明；全选提交全部模板', async () => {
    tasks = [
      {
        body: {
          items: [
            receipt(0, {
              ok: true,
              taskId: '84810000-0000-4000-8000-000000000302',
              status: 'failed',
              failureReason: 'EMPLOYEE_NO_ACCOUNT',
            }),
            receipt(2, { ok: false, code: 'NOT_FOUND' }),
            receipt(3, { ok: false, code: 'ESIGN_TASK_IN_PROGRESS' }),
          ],
        },
      },
    ];
    await render();
    await check(0, 2, 3);
    await click(reissueButton());
    await click(modal()?.querySelector('input[name="esignTemplateAll"]'));
    await click(modalButton('确定'));
    expect(posts.map((post) => post.body)).toEqual([
      { items: [0, 2, 3].map((index) => ({ businessId: ROWS[index]!.id })), templateIds: [T1, T2] },
    ]);
    const text = modal()?.textContent ?? '';
    expect(text).toContain('发起失败：员工没有可登录的账号，无法签署');
    expect(text).toContain('合成员工丙');
    expect(text).toContain('不可发起：不是可发起签署的调动，或不在您的操作范围内');
    expect(text).toContain('不可发起：已有签署中的任务');
    expect(text).not.toMatch(/ESIGN_|NOT_FOUND|EMPLOYEE_NO_ACCOUNT/);
  });

  it('FE-02-04 没有可用模板：弹窗提示去设置维护，确定不可点', async () => {
    options = { body: { items: [] } };
    await render();
    await check(0);
    await click(reissueButton());
    expect(modal()?.textContent).toContain('暂无可用的签署模板，请先在 电子签 > 设置 > 签署模板 中维护');
    expect(modalButton('确定')?.disabled).toBe(true);
  });

  it('FE-02-05 整批被拒（模板不可用）显示后端中文原因，可改选后重提', async () => {
    tasks = [
      // 后端形状：apps/api esign/transfer-input.ts validateSignTemplates（VALIDATION_FAILED + details.reason）
      {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: '签署模板不可用',
            details: { reason: 'ESIGN_TEMPLATE_UNAVAILABLE', templateIds: [T1] },
          },
        },
      },
      {
        body: {
          items: [
            receipt(0, {
              ok: true,
              taskId: '84810000-0000-4000-8000-000000000303',
              status: 'signing',
              failureReason: null,
            }),
          ],
        },
      },
    ];
    await render();
    await check(0);
    await click(reissueButton());
    await pick(T1);
    await click(modalButton('确定'));
    expect(modal()?.textContent).toContain('签署模板不可用');
    await pick(T2);
    await click(modalButton('确定'));
    expect(posts.map((post) => (post.body as { templateIds: string[] }).templateIds)).toEqual([[T1], [T2]]);
    expect(posts[0]!.key).not.toBe(posts[1]!.key);
    expect(modal()?.textContent).toContain('已发起签署');
  });

  it('FE-02-06 结果未知：锁定不另起命令；用户点“按原命令重发”沿用同一命令 ID 与报文', async () => {
    tasks = [
      { status: 503, body: { error: { code: 'UNAVAILABLE', message: '服务暂不可用' } } },
      {
        body: {
          items: [
            receipt(0, {
              ok: true,
              taskId: '84810000-0000-4000-8000-000000000304',
              status: 'signing',
              failureReason: null,
            }),
          ],
        },
      },
    ];
    await render();
    await check(0);
    await click(reissueButton());
    await pick(T1);
    await click(modalButton('确定'));
    expect(modal()?.textContent).toContain('结果待确认');
    expect(modalButton('确定')?.disabled).toBe(true);
    await click(modalButton('按原命令重发'));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(modal()?.textContent).toContain('已发起签署');
  });

  it('FE-02-07 没有 MulLaunchESignTranfer 按钮权限时不显示补发按钮', async () => {
    buttons = [{ buttonCode: 'update', level: 'detail' }];
    await render();
    expect(reissueButton()).toBeUndefined();
  });

  it('FE-02-08 调动管理工具栏「调动处理」仍禁用（列表是演示数据，不接补发）', () => {
    expect(pageModel.transferTools.completed).toContain('process');
    expect(pageModel.enabledTools).not.toContain('process');
  });
});
