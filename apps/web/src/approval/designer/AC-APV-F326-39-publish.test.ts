/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-39（F-326 S7b，主设计 §5.5 ④⑦）设计器发布：
 * - 发布被 APPROVAL_SPECIFIED_APPROVER_REQUIRED 拒：按 details.slots 标出节点，同句提示；
 * - APPROVAL_PENDING_VARIABLE_CONFLICT：弹窗逐个列“设计器值 / 变量页当前值”，选后带 pendingResolutions
 *   以新命令 ID 重新发布；再次 409 时显示新值；
 * - 保存草稿按回显的指定人员提交，未选人提交 value:null。
 * 页面经 PAGES 登记加载；错误体形状照后端 approvalError（{ error: { code, message, details } }），合成 ID。
 */
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApproverSource } from '@italent/domain';
import { PAGES } from '../../foundation/routes.js';
import { SessionProvider } from '../../foundation/Session.js';
import { PermissionsProvider } from '../../foundation/Permissions.js';
import { flowFixture, flowId } from '../../../../../tests/acceptance/support/f315-fixture.js';

const BASE = '/api/tenant/approval/processes';
const PEOPLE = '/api/tenant/approval/designer/person-candidates';
const A = 'b3290000-0000-4000-8000-0000000000a1';
const B = 'b3290000-0000-4000-8000-0000000000b2';
const C = 'b3290000-0000-4000-8000-0000000000c3';
const X = 'b3290000-0000-4000-8000-000000000101';
const Y = 'b3290000-0000-4000-8000-000000000102';
const NAMES: Record<string, string> = { [A]: '合成甲', [B]: '合成乙', [C]: '合成丙' };
const REQUIRED = '节点「人事审批」的指定人员未选择，请选择人员后再发布';
const CONFLICT_MESSAGE = '公共变量在草稿期间已在变量页修改，请选择采用设计器值或保留变量页值后再发布';

const auto = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'public_variable',
    value: id,
    autoVariable: { id, code: `Global.B.SynthAuto${id.slice(-1)}`, status: 'enabled', revision: 2, ...extra },
  }) as unknown as ApproverSource;
function processView() {
  const flow = flowFixture();
  const [manager, hr] = flow.latestVersion.nodes as unknown as { approver: ApproverSource }[];
  manager!.approver = auto(X, { userIds: [A], referencingProcessCount: 1 });
  hr!.approver = auto(Y, { userIds: null, referencingProcessCount: 1 });
  return flow;
}

let host: HTMLDivElement;
let root: Root;
let writes: { url: string; method: string; body: unknown; headers: Headers }[];
let publish: (body: unknown, count: number) => Response;

const text = () => document.body.textContent ?? '';
const squash = (node: Element | null) => node?.textContent?.replace(/\s/g, '') ?? '';
const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
async function click(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLElement>('button, [role="radio"], label')].find(
    (node) => squash(node) === label,
  );
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
const lastDialog = () =>
  [...document.querySelectorAll<HTMLElement>('.ant-modal')]
    .filter((node) => node.closest<HTMLElement>('.ant-modal-wrap')?.style.display !== 'none')
    .at(-1);
const publishes = () => writes.filter((item) => item.url.endsWith('/publish'));

async function render() {
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
  for (let i = 0; i < 100 && !text().includes('保存草稿'); i += 1) await settle();
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  publish = () => Response.json({ error: { code: 'CONFLICT', message: '未设置' } }, { status: 409 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = String(input);
    const url = new URL(raw, 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ url: url.pathname, method, body, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith('/publish')) return publish(body, publishes().length);
      const saved = processView();
      return Response.json({ ...saved, revision: saved.revision + 1 });
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
        dataOperations: { read: true, update: true },
        viewableFields: ['code', 'name', 'approvalType', 'nodes', 'conditions', 'description', 'groupName'],
        editableFields: ['nodes'],
        buttons: ['update', 'newVersion', 'publish'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
      });
    if (url.pathname === `${BASE}/${flowId}`) return Response.json(processView());
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

it('AC-APV-F326-39-10 保存草稿：回显的指定人员原样提交，未选人提交 value:null，不回传变量引用', async () => {
  await render();
  await click('保存草稿');
  const save = writes.find((item) => item.method === 'PUT');
  expect(save?.url).toBe(`${BASE}/${flowId}/draft`);
  const nodes = (save!.body as { nodes: { approver: unknown }[] }).nodes;
  expect(nodes.map((node) => node.approver)).toEqual([
    { type: 'specified', value: A },
    { type: 'specified', value: null },
  ]);
  expect(JSON.stringify(save!.body)).not.toContain('autoVariable');
});

it('AC-APV-F326-39-11 发布被“指定人员未选择”拒：按 details.slots 标出节点并给同句提示', async () => {
  publish = () =>
    Response.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: REQUIRED,
          details: {
            reason: 'APPROVAL_SPECIFIED_APPROVER_REQUIRED',
            slots: [{ nodeKey: 'hr', nodeName: '人事审批', slot: 'approver' }],
          },
        },
      },
      { status: 400 },
    );
  await render();
  await click('发布');
  expect(publishes()).toHaveLength(1);
  expect(publishes()[0]!.headers.get('if-match')).toBe('4');
  expect(text()).toContain(REQUIRED);
  const marked = [...document.querySelectorAll('[data-node-missing="true"]')].map((node) => squash(node));
  expect(marked).toEqual(['2人事审批']);
  // 标出的节点被选中，审批人来源处同句提示
  expect(squash(document.querySelector('[aria-current="true"]'))).toBe('2人事审批');
  expect(document.querySelector('.flow-source-group .ant-alert-error')?.textContent).toContain(REQUIRED);
});

it('AC-APV-F326-39-12 待生效冲突：弹窗列设计器值与变量页当前值，选后带 pendingResolutions、新命令 ID 重发', async () => {
  const conflict = (revision: number, current: string[]) =>
    Response.json(
      {
        error: {
          code: 'CONFLICT',
          message: CONFLICT_MESSAGE,
          details: {
            reason: 'APPROVAL_PENDING_VARIABLE_CONFLICT',
            conflicts: [
              {
                variableId: X,
                code: 'Global.B.SynthAuto1',
                name: '上级审批-指定人员',
                nodeKey: 'manager',
                revision,
                designerUserIds: [A],
                currentUserIds: current,
              },
            ],
          },
        },
      },
      { status: 409 },
    );
  publish = (_body, count) => {
    if (count === 1) return conflict(5, [B]);
    if (count === 2) return conflict(6, [C]);
    const done = processView();
    return Response.json({
      ...done,
      revision: done.revision + 1,
      latestVersion: { ...done.latestVersion, status: 'published', publishedAt: '2026-11-17T00:00:00Z' },
    });
  };
  await render();
  await click('发布');
  let dialog = lastDialog();
  expect(dialog?.textContent).toContain('Global.B.SynthAuto1');
  expect(dialog?.textContent).toContain('设计器值');
  expect(dialog?.textContent).toContain('合成甲');
  expect(dialog?.textContent).toContain('变量页当前值');
  expect(dialog?.textContent).toContain('合成乙');
  await click('采用变量页当前值', dialog);
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(2);
  expect(publishes()[1]!.body).toEqual({ pendingResolutions: [{ variableId: X, revision: 5, choice: 'current' }] });
  const [first, second] = publishes().map((item) => item.headers.get('idempotency-key'));
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  // 选择之后变量又被改：再次 409，弹窗换成新值
  dialog = lastDialog();
  expect(dialog?.textContent).toContain('合成丙');
  expect(dialog?.textContent).not.toContain('合成乙');
  await click('采用设计器值', dialog);
  await click('确认发布', dialog);
  expect(publishes()).toHaveLength(3);
  expect(publishes()[2]!.body).toEqual({ pendingResolutions: [{ variableId: X, revision: 6, choice: 'designer' }] });
  expect(new Set(publishes().map((item) => item.headers.get('idempotency-key'))).size).toBe(3);
  expect(text()).toContain('已发布');
});
