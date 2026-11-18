/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-39（F-326 S7b 第 1 轮审查返工，主设计 §5.5 ④⑦）设计器发布：
 * - 39-14（P1-1）版本冲突重读后先展示最新草稿，再由用户显式发布（If-Match 为新版本）；
 * - 39-15（P2-1）多个待生效冲突：再次 409 只重选过期项，仍有效的选择一并重发；
 * - 39-16（P2-2）提交成功、响应丢失、退出重开：仍显示原目标版本与回查到的发布状态，不自动重发，按原单重发同键同体；
 * - 39-17（P2-3）改动后又改回原值：按实际可提交值判断，直接发布、不额外保存草稿；
 * - 39-18（P2-4）只有发布按钮权限：保存不可用、发布可用；
 * - 39-19（P2-5）迟到的发布成功回执不刷新用户已切换到的“查看生效版本”。
 * 第 2 轮审查返工（同一缺陷在原用例没走到的路径上）：
 * - 39-24（P2-1）结果未知退出重开、按原单重发后再次 409：仍有效的选择从原命令恢复，下一笔同时带 X@1 与 Y@2；
 * - 39-25 / 39-26（P2-3）按保存的提交归一化（名称去首尾空格）判断：只差首尾空格直接发布；真实改名、空白名称仍拦；
 * - 39-27 / 39-28（P2-4）发布只看发布按钮授权，不看节点字段权限：节点可看不可编辑时发布可用、编辑不可用；
 *   缺 publish 按钮或对象更新操作时仍无发布入口。
 * 页面经 PAGES 登记加载；读视图与错误体形状照后端（ProcessView / approvalError），合成 ID。
 */
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApproverSource } from '@italent/domain';
import { PAGES } from '../../foundation/routes.js';
import { SessionProvider } from '../../foundation/Session.js';
import { PermissionsProvider } from '../../foundation/Permissions.js';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import type { ProcessView } from './model.js';

const BASE = '/api/tenant/approval/processes';
const PEOPLE = '/api/tenant/approval/designer/person-candidates';
const A = 'b3290000-0000-4000-8000-0000000000a1';
const B = 'b3290000-0000-4000-8000-0000000000b2';
const C = 'b3290000-0000-4000-8000-0000000000c3';
const X = 'b3290000-0000-4000-8000-000000000101';
const Y = 'b3290000-0000-4000-8000-000000000102';
const NAMES: Record<string, string> = { [A]: '合成甲', [B]: '合成乙', [C]: '合成丙' };

const auto = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'public_variable',
    value: id,
    autoVariable: { id, code: `Global.B.SynthAuto${id.slice(-1)}`, status: 'enabled', revision: 2, ...extra },
  }) as unknown as ApproverSource;
// 内核恢复槽按流程 id 存在模块级存储里：每个用例用自己的流程，前一用例留下的命令不影响后一用例。
let flowId = '';
let serial = 0;
function processView(managerPeople = [A], revision = 4): ProcessView {
  const flow = { ...flowFixture(), id: flowId };
  const [manager, hr] = flow.latestVersion.nodes as unknown as { approver: ApproverSource }[];
  manager!.approver = auto(X, { userIds: managerPeople, referencingProcessCount: 1 });
  hr!.approver = auto(Y, { userIds: [C], referencingProcessCount: 1 });
  return { ...flow, revision } as ProcessView;
}
const published = (view: ProcessView): ProcessView => {
  const version = { ...view.latestVersion, status: 'published', publishedAt: '2026-11-17T00:00:00Z' };
  return { ...view, revision: view.revision + 1, latestVersion: version, currentVersion: version } as ProcessView;
};
/** 已有生效版本 1、最新为草稿版本 2 的流程（“查看生效版本”可用）。 */
function withCurrent(): ProcessView {
  const view = processView();
  const current = { ...view.latestVersion, id: 'a2000000-0000-4000-8000-000000000009', status: 'published' };
  return {
    ...view,
    currentVersion: { ...current, versionNo: 1, publishedAt: '2026-11-01T00:00:00Z' },
    latestVersion: { ...view.latestVersion, versionNo: 2 },
  } as ProcessView;
}
const failure = (status: number, code: string, message: string, details?: unknown) =>
  Response.json({ error: { code, message, details } }, { status });
const pendingConflict = (conflicts: unknown[]) =>
  failure(409, 'CONFLICT', '公共变量在草稿期间已在变量页修改，请选择采用设计器值或保留变量页值后再发布', {
    reason: 'APPROVAL_PENDING_VARIABLE_CONFLICT',
    conflicts,
  });
const conflictItem = (variableId: string, revision: number, designer: string[], current: string[]) => ({
  variableId,
  code: `Global.B.SynthAuto${variableId.slice(-1)}`,
  name: variableId === X ? '上级审批-指定人员' : '人事审批-指定人员',
  nodeKey: variableId === X ? 'manager' : 'hr',
  revision,
  designerUserIds: designer,
  currentUserIds: current,
});

let host: HTMLDivElement;
let root: Root;
let writes: { url: string; method: string; body: unknown; headers: Headers }[];
let reads: number;
let view: ProcessView;
let buttons: string[];
let fields: { viewable: string[]; editable: string[]; update: boolean };
const VIEWABLE = ['code', 'name', 'approvalType', 'nodes', 'conditions', 'description', 'groupName'];
const fullAccess = () => {
  buttons = ['update', 'newVersion', 'publish'];
  fields = { viewable: [...VIEWABLE], editable: ['nodes'], update: true };
};
let publish: (body: unknown, count: number) => Response | Promise<Response>;

const text = () => document.body.textContent ?? '';
const squash = (node: Element | null) => node?.textContent?.replace(/\s/g, '') ?? '';
const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
const find = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLElement>('button, [role="radio"], label')].find((node) => squash(node) === label);
async function click(label: string, scope: ParentNode = document) {
  const target = find(label, scope);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
const lastDialog = () =>
  [...document.querySelectorAll<HTMLElement>('.ant-modal')]
    .filter((node) => node.closest<HTMLElement>('.ant-modal-wrap')?.style.display !== 'none')
    .at(-1);
const publishes = () => writes.filter((item) => item.url.endsWith('/publish'));
async function choose(dialog: HTMLElement | undefined, variableId: string, label: string) {
  const name = variableId === X ? '上级审批-指定人员' : '人事审批-指定人员';
  const section = [...(dialog?.querySelectorAll('.flow-pending-conflict') ?? [])].find((item) =>
    item.textContent?.includes(name),
  );
  expect(section, name).toBeDefined();
  await click(label, section!);
}
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function render(ready = '保存草稿') {
  const Page = PAGES.configurations.find((item) => item.id === 'processes')!.page!.Component;
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: 'synthetic-admin',
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成管理员',
          source: 'server',
        },
        children: h(PermissionsProvider, {
          children: h(MemoryRouter, {
            initialEntries: [`/config-center/workflow/processes/${flowId}`],
            children: h(Routes, {
              children: h(Route, {
                path: '/config-center/workflow/processes/*',
                element: h(Suspense, { fallback: null, children: h(Page) }),
              }),
            }),
          }),
        }),
      }),
    ),
  );
  for (let i = 0; i < 100 && !text().includes(ready); i += 1) await settle();
  await settle();
}
async function reopen(ready: string) {
  await act(() => root.unmount());
  root = createRoot(host);
  await render(ready);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  serial += 1;
  flowId = `a1000000-0000-4000-8000-0000000003${String(serial).padStart(2, '0')}`;
  writes = [];
  reads = 0;
  view = processView();
  fullAccess();
  publish = () => Response.json(published(view));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ url: url.pathname, method, body, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith('/publish')) return publish(body, publishes().length);
      return Response.json({ ...view, revision: view.revision + 1 });
    }
    if (url.pathname.endsWith('/permission/me/snapshot'))
      return Response.json({
        session: { tenantId: 'synthetic-tenant', userId: 'synthetic-admin', timezone: 'Asia/Shanghai' },
        apps: [
          { app: 'approval', visible: true, entryObjects: ['TenantBase.ApprovalProcess'] },
          { app: 'settings', visible: true, entryObjects: [] },
        ],
        scope: [],
        adminMenus: [{ code: 'matrix.manage', path: '审批矩阵', editable: true }],
      });
    if (url.pathname.includes('/permission/me/objects/'))
      return Response.json({
        objectCode: 'TenantBase.ApprovalProcess',
        dataOperations: { read: true, update: fields.update },
        viewableFields: fields.viewable,
        editableFields: fields.editable,
        buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
      });
    if (url.pathname === `${BASE}/${flowId}`) {
      reads += 1;
      return Response.json(view);
    }
    if (url.pathname === PEOPLE)
      return Response.json({
        items: (url.searchParams.get('userIds') ?? '')
          .split(',')
          .filter((id) => NAMES[id])
          .map((userId) => ({ userId, name: NAMES[userId], code: null, departmentName: null })),
        hasMore: false,
      });
    return Response.json({ items: [], hasMore: false });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('AC-APV-F326-39-14 版本冲突重读后先展示最新草稿（乙改的人员），再显式发布，If-Match 为新版本', async () => {
  publish = () => failure(409, 'REVISION_CONFLICT', '版本已变化');
  await render();
  expect(text()).toContain('指定人员：合成甲');
  await click('发布');
  expect(publishes()).toHaveLength(1);
  // 期间乙把上级审批改成合成乙并保存（流程版本 4 → 5）
  view = processView([B], 5);
  await click('重读最新版本');
  expect(text()).toContain('指定人员：合成乙');
  expect(text()).not.toContain('指定人员：合成甲');
  // 重读本身不发布：仍只有第一笔，等用户看过后再点发布
  expect(publishes()).toHaveLength(1);
  publish = () => Response.json(published(view));
  await click('发布');
  expect(publishes()).toHaveLength(2);
  expect(publishes()[1]!.headers.get('if-match')).toBe('5');
  expect(text()).toContain('流程已发布');
});

it('AC-APV-F326-39-15 多个待生效冲突：再次 409 只重选过期项，第三笔以新命令 ID 同时带 X@1 与 Y@2', async () => {
  publish = (_body, count) => {
    if (count === 1) return pendingConflict([conflictItem(X, 1, [A], [B]), conflictItem(Y, 1, [C], [B])]);
    if (count === 2) return pendingConflict([conflictItem(Y, 2, [C], [A])]);
    return Response.json(published(view));
  };
  await render();
  await click('发布');
  let dialog = lastDialog();
  await choose(dialog, X, '采用变量页当前值');
  await choose(dialog, Y, '采用设计器值');
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(2);
  expect(publishes()[1]!.body).toEqual({
    pendingResolutions: expect.arrayContaining([
      { variableId: X, revision: 1, choice: 'current' },
      { variableId: Y, revision: 1, choice: 'designer' },
    ]),
  });
  // 第二笔里 X 的选择仍有效，只有 Y 又被改过（revision 2），弹窗只让重选 Y
  dialog = lastDialog();
  expect(dialog?.textContent).toContain('人事审批-指定人员');
  expect(dialog?.textContent).not.toContain('上级审批-指定人员');
  await choose(dialog, Y, '采用设计器值');
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(3);
  const third = (publishes()[2]!.body as { pendingResolutions: unknown[] }).pendingResolutions;
  expect(third).toHaveLength(2);
  expect(third).toEqual(
    expect.arrayContaining([
      { variableId: X, revision: 1, choice: 'current' },
      { variableId: Y, revision: 2, choice: 'designer' },
    ]),
  );
  expect(new Set(publishes().map((item) => item.headers.get('idempotency-key'))).size).toBe(3);
  expect(text()).toContain('流程已发布');
});

it('AC-APV-F326-39-17 改动节点名称后又改回原值：按实际可提交值判断，直接发布且不额外保存草稿', async () => {
  await render();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="节点名称"]')!;
  expect(input.value).toBe('上级审批');
  await type(input, '上级审批（改）');
  await type(input, '上级审批');
  await click('发布');
  expect(text()).not.toContain('有未保存的修改，请先保存草稿再发布');
  expect(writes.filter((item) => item.method === 'PUT')).toHaveLength(0);
  expect(publishes()).toHaveLength(1);
  expect(publishes()[0]!.headers.get('if-match')).toBe('4');
});

it('AC-APV-F326-39-18 只有发布按钮权限：保存草稿不可用，发布可用并可发出', async () => {
  buttons = ['publish'];
  await render('发布');
  const save = document.querySelector<HTMLButtonElement>('button[aria-label="保存草稿"]');
  expect(save === null || save.disabled).toBe(true);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="发布"]');
  expect(button, '发布按钮').not.toBeNull();
  expect(button!.disabled).toBe(false);
  await click('发布');
  expect(publishes()).toHaveLength(1);
  expect(writes.filter((item) => item.method === 'PUT')).toHaveLength(0);
});

it('AC-APV-F326-39-19 迟到的发布成功回执：用户已切到“查看生效版本”时不刷新、不切回', async () => {
  view = withCurrent();
  let deliver: (response: Response) => void = () => {};
  publish = () => new Promise<Response>((resolve) => (deliver = resolve));
  await render();
  await click('发布');
  expect(publishes()).toHaveLength(1);
  await click('查看生效版本');
  expect(find('查看生效版本')?.className).toContain('ant-btn-primary');
  const before = reads;
  const done = published(view);
  view = done;
  await act(async () => deliver(Response.json(done)));
  await settle();
  // 命令照常落定，但页面不按迟到回执刷新：仍停在生效版本视图
  expect(reads).toBe(before);
  expect(find('查看生效版本')?.className).toContain('ant-btn-primary');
  expect(text()).not.toContain('流程已发布');
});

it('AC-APV-F326-39-24 结果未知退出重开、按原单重发后再次 409：仍有效的 X 从原命令恢复，下一笔同时带 X@1 与 Y@2', async () => {
  publish = (_body, count) => {
    if (count === 1) return pendingConflict([conflictItem(X, 1, [A], [B]), conflictItem(Y, 1, [C], [B])]);
    // 带两项选择的第二笔：响应丢失
    if (count === 2) throw new TypeError('network');
    // 按原单重发：服务端只报告 Y 又被改过（revision 2），X 的选择仍有效
    if (count === 3) return pendingConflict([conflictItem(Y, 2, [C], [A])]);
    return Response.json(published(view));
  };
  await render();
  await click('发布');
  let dialog = lastDialog();
  await choose(dialog, X, '采用变量页当前值');
  await choose(dialog, Y, '采用设计器值');
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(2);
  expect(text()).toContain('处理中 / 结果待确认');
  await reopen('本次发布的目标版本');
  await click('回查原单');
  await click('按原单重发');
  expect(publishes()).toHaveLength(3);
  expect(publishes()[2]!.headers.get('idempotency-key')).toBe(publishes()[1]!.headers.get('idempotency-key'));
  expect(publishes()[2]!.body).toEqual(publishes()[1]!.body);
  dialog = lastDialog();
  expect(dialog?.textContent).toContain('人事审批-指定人员');
  expect(dialog?.textContent).not.toContain('上级审批-指定人员');
  await choose(dialog, Y, '采用设计器值');
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(4);
  const fourth = (publishes()[3]!.body as { pendingResolutions: unknown[] }).pendingResolutions;
  expect(fourth).toHaveLength(2);
  expect(fourth).toEqual(
    expect.arrayContaining([
      { variableId: X, revision: 1, choice: 'current' },
      { variableId: Y, revision: 2, choice: 'designer' },
    ]),
  );
  expect(publishes()[3]!.headers.get('idempotency-key')).not.toBe(publishes()[2]!.headers.get('idempotency-key'));
  expect(text()).toContain('流程已发布');
});

it('AC-APV-F326-39-25 节点名称只差首尾空格（保存会去掉）：按提交值未变，直接发布且不保存草稿', async () => {
  await render();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="节点名称"]')!;
  await type(input, '上级审批 ');
  await click('发布');
  expect(text()).not.toContain('有未保存的修改，请先保存草稿再发布');
  expect(writes.filter((item) => item.method === 'PUT')).toHaveLength(0);
  expect(publishes()).toHaveLength(1);
  expect(publishes()[0]!.headers.get('if-match')).toBe('4');
});

it('AC-APV-F326-39-26 真实改名与空白名称仍按未保存拦下，不发出发布', async () => {
  await render();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="节点名称"]')!;
  for (const name of [' 上级审批（改） ', '   ']) {
    await type(input, name);
    await click('发布');
    expect(text(), name).toContain('有未保存的修改，请先保存草稿再发布');
    expect(publishes(), name).toHaveLength(0);
  }
  expect(writes).toHaveLength(0);
});

it('AC-APV-F326-39-27 节点可看不可编辑（有流程管理能力、对象更新操作与 publish 按钮）：发布可用，编辑控件不可用', async () => {
  fields.editable = [];
  await render('上级审批');
  const input = document.querySelector<HTMLInputElement>('input[aria-label="节点名称"]');
  expect(input, '节点名称').not.toBeNull();
  expect(input!.disabled).toBe(true);
  const save = document.querySelector<HTMLButtonElement>('button[aria-label="保存草稿"]');
  expect(save === null || save.disabled).toBe(true);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="发布"]');
  expect(button, '发布按钮').not.toBeNull();
  expect(button!.disabled).toBe(false);
  await click('发布');
  expect(publishes()).toHaveLength(1);
  expect(writes.filter((item) => item.method === 'PUT')).toHaveLength(0);
});

it('AC-APV-F326-39-28 发布入口只看流程管理能力 + publish 按钮（含其依赖的更新操作），不看节点字段权限', async () => {
  const cases = [
    {
      name: '节点不可看也不可编辑',
      setup: () => (fields = { ...fields, viewable: VIEWABLE.filter((f) => f !== 'nodes'), editable: [] }),
      usable: true,
    },
    { name: '缺 publish 按钮', setup: () => (buttons = ['update', 'newVersion']), usable: false },
    { name: '缺对象更新操作', setup: () => (fields = { ...fields, update: false }), usable: false },
  ];
  for (const item of cases) {
    fullAccess();
    item.setup();
    await reopen('合成调动流程');
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="发布"]');
    expect(!!button && !button.disabled, item.name).toBe(item.usable);
  }
});

// 本用例在内核存储里留结果未知的命令，最后以按原单重发落定，放在文件末尾。
it('AC-APV-F326-39-16 提交成功、响应丢失、退出重开：显示原目标版本与回查状态，不自动重发；按原单重发同键同体', async () => {
  publish = () => {
    // 服务端已发布，响应在路上丢失
    view = published(processView());
    throw new TypeError('network');
  };
  await render();
  await click('发布');
  expect(text()).toContain('处理中 / 结果待确认');
  await reopen('本次发布的目标版本');
  // 重开后最新版本已是已发布（不能再发布），恢复入口仍在
  expect(text()).toContain('处理中 / 结果待确认');
  expect(text()).toContain('本次发布的目标版本：版本 1');
  await click('回查原单');
  expect(text()).toContain('该版本当前状态：已发布（仅供核对，不能据此确认本次发布结果）');
  // 一次 GET 不是原命令的回执：仍是结果待确认，也没有第二笔 POST
  expect(text()).toContain('处理中 / 结果待确认');
  expect(publishes()).toHaveLength(1);
  publish = () => Response.json(view);
  await click('按原单重发');
  expect(publishes()).toHaveLength(2);
  const [first, second] = publishes();
  expect(second!.headers.get('idempotency-key')).toBe(first!.headers.get('idempotency-key'));
  expect(second!.headers.get('if-match')).toBe('4');
  expect(second!.body).toEqual(first!.body);
  expect(text()).not.toContain('处理中 / 结果待确认');
});
