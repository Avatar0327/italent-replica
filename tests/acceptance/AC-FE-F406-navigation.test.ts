/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { act, createElement: h } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { BrowserRouter, Routes, Route, useNavigate } = requireWeb('react-router');
const { ContractButtons } = await import(resolve('apps/web/src/contracts/ContractForm.tsx'));
const { PlanList } = await import(resolve('apps/web/src/idp/PlanList.tsx'));
const { TemplateList } = await import(resolve('apps/web/src/idp/TemplateList.tsx'));

type Values = Record<string, unknown>;
const row = { id: 'synthetic-source', revision: 1, employeeId: 'synthetic-person', status: 'draft' };
const clear = vi.fn();
const refresh = vi.fn();
let release: (value: unknown) => void;
let pending: Promise<unknown>;
let submitting: Promise<unknown> | undefined;
let navigate: (path: string) => void;
const run = vi.fn(() => pending);
const request = vi.fn(() => pending);

// 保留真实三个页面及提交 / 删除回调；只替换命令边界和无关展示组件，回执由测试显式释放。
vi.mock('../../apps/web/src/foundation/Session.js', () => ({ useApiClient: () => ({ request }) }));
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({ can: () => true, field: () => ({ visible: true, editable: true }) }),
}));
vi.mock('../../apps/web/src/contracts/commands.js', () => ({
  useContractCommand: () => ({
    clear,
    submit: async (input: { values: Values; send(command: Values): Promise<unknown> }) => {
      await input.send({ id: 'synthetic-command', revision: 0, body: input.values });
      return { status: 'done' };
    },
  }),
}));
vi.mock('../../apps/web/src/contracts/useRead.js', () => ({ useRead: () => ({ data: {} }) }));
vi.mock('../../apps/web/src/contracts/references.js', async (original) => ({
  ...(await original<object>()),
  useToday: () => '2026-11-17',
}));
vi.mock('../../apps/web/src/foundation/FormOverlay.js', () => ({
  FormOverlay: ({ onSubmit, onClose }: { onSubmit(values: Values): Promise<unknown>; onClose(): void }) =>
    h(
      'div',
      null,
      h(
        'button',
        {
          onClick: () => {
            submitting = onSubmit({ number: 'SYNTHETIC-406' });
          },
        },
        '提交合同',
      ),
      h('button', { onClick: onClose }, '关闭合同表单'),
    ),
}));
vi.mock('../../apps/web/src/idp/api.js', async (original) => ({
  ...(await original<object>()),
  useCollection: () => ({ items: [], loading: false, reload: refresh }),
  useCommand: () => ({ run, clear, locked: false, busy: false }),
}));
vi.mock('../../apps/web/src/idp/useNames.js', () => ({ useNames: () => (id: string) => id }));
vi.mock('../../apps/web/src/idp/PlanDetail.js', () => ({
  PlanDetailPage: ({ intervene }: { intervene(kind: string, value: Values): void }) =>
    h('button', { onClick: () => intervene('delete', row) }, '删除计划'),
}));
vi.mock('../../apps/web/src/idp/TemplateDetail.js', () => ({
  TemplateDetailPage: ({ actions }: { actions(value: Values): unknown }) => h('div', null, actions(row)),
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
vi.mock('../../apps/web/src/foundation/templates.js', () => ({ ListPage: () => h('p', null, '列表') }));
vi.mock('../../apps/web/src/idp/listing.js', async (original) => ({
  ...(await original<object>()),
  CommandNotice: () => null,
}));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const current = () => `${window.location.pathname}${window.location.search}`;
async function click(label: string) {
  const button = [...document.body.querySelectorAll('button')].find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  );
  expect(button, `应有按钮：${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function go(path: string) {
  await act(async () => navigate(path));
}
async function traverse(step: () => void) {
  const popped = new Promise((done) => window.addEventListener('popstate', done, { once: true }));
  await act(async () => {
    step();
    await popped;
  });
}
function Navigation() {
  navigate = useNavigate();
  return null;
}
const cases = [
  {
    name: '合同提交',
    path: '/contracts',
    query: '',
    button: '提交合同',
    target: '/contracts/records/synthetic-result',
  },
  {
    name: 'IDP 计划删除',
    path: '/idp/plans',
    query: '?plan=synthetic-source',
    button: '删除计划',
    target: '/idp/plans',
  },
  {
    name: 'IDP 模板删除',
    path: '/idp/templates',
    query: '?template=synthetic-source',
    button: '删除',
    target: '/idp/templates',
  },
];
async function mount(item: (typeof cases)[number]) {
  window.history.replaceState(null, '', item.path + item.query);
  await act(async () =>
    root.render(
      h(
        BrowserRouter,
        null,
        h(Navigation),
        h(
          Routes,
          null,
          h(Route, {
            path: '/contracts',
            element: h(ContractButtons, {
              ops: ['create'],
              employee: { value: row.employeeId, label: '合成人员' },
              onDone: refresh,
            }),
          }),
          h(Route, { path: '/idp/plans', element: h(PlanList) }),
          h(Route, { path: '/idp/templates', element: h(TemplateList) }),
          h(Route, { path: '/elsewhere', element: h('p', null, '另一页面') }),
          h(Route, { path: '/contracts/records/:id', element: h('p', null, '合同记录') }),
        ),
      ),
    ),
  );
  if (item.name === '合同提交') {
    // 新签与新签申请并列；点击第一个直接操作入口。
    await act(async () => host.querySelector('button')!.click());
    await click(item.button);
    expect(request).toHaveBeenCalledTimes(1);
  } else {
    await click(item.button);
    await click('确定');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([
      `/api/tenant/idp/${item.path.endsWith('plans') ? 'plans' : 'templates'}/${row.id}`,
      'DELETE',
      {},
      1,
    ]);
  }
  expect(clear).not.toHaveBeenCalled();
}
async function finish() {
  await act(async () => {
    release({
      id: 'synthetic-result',
      employeeId: row.employeeId,
      revision: 1,
      status: 'valid',
      approvalStatus: 'effective',
    });
    await submitting;
    await pending;
  });
  expect(clear).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  pending = new Promise((done) => {
    release = done;
  });
  submitting = undefined;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe.each(cases)('AC-FE-F406 $name', (item) => {
  it('确认在途时离页卸载，迟到成功不改变当前地址，仍清理命令并刷新', async () => {
    await mount(item);
    await go('/elsewhere?keep=1');
    await finish();
    expect(current()).toBe('/elsewhere?keep=1');
  });
  it('确认在途时页内导航，迟到成功不覆盖新的查询参数', async () => {
    await mount(item);
    const target = `${item.path}${item.query ? `${item.query}&` : '?'}keep=1`;
    await go(target);
    await finish();
    expect(current()).toBe(target);
  });
  it('确认在途时后退再前进，回到同一历史项也不复活旧导航', async () => {
    await mount(item);
    await go(`${item.path}${item.query ? `${item.query}&` : '?'}keep=1`);
    await traverse(() => window.history.back());
    await traverse(() => window.history.forward());
    await traverse(() => window.history.back());
    await finish();
    expect(current()).toBe(item.path + item.query);
  });
  it('未离页且没有导航，确认成功仍跳到记录或关闭已删除详情', async () => {
    await mount(item);
    await finish();
    expect(current()).toBe(item.target);
  });
});

it('AC-FE-F406 只关闭合同表单、页面仍在，确认成功仍完成导航', async () => {
  await mount(cases[0]!);
  await click('关闭合同表单');
  await finish();
  expect(current()).toBe(cases[0]!.target);
});
