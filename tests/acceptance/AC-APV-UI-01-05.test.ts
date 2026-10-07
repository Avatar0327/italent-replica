/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/approval/ApprovalPage.tsx');
const API = '/api/tenant/approval';
const INSTANCE = '10000000-0000-4000-8000-000000000001';
const TASK = '20000000-0000-4000-8000-000000000001';
const RETRIEVE = '20000000-0000-4000-8000-000000000002';
const USER = '30000000-0000-4000-8000-00000000000a';
const BUSINESS = '40000000-0000-4000-8000-00000000000a';
const TENANT = 'synthetic-tenant';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成调动申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'manager',
    taskId: TASK,
    retrieveTaskId: RETRIEVE,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [
      {
        id: TASK,
        nodeKey: 'manager',
        nodeName: '经理审批',
        status: 'pending',
        assigneeUserId: USER,
        origin: 'normal',
        isExceptionAdmin: false,
        adminSelfTransfer: false,
      },
    ],
    logs: [],
    recordsHidden: false,
    commentNotice: '审批意见默认对所有能查看本单的人公开，请勿在意见中填写敏感信息',
    form: { values: { effectiveDate: '2026-11-01' }, editMode: 'none', editableFields: [] },
    actions: ['approve'],
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface RequestCall {
  readonly url: string;
  readonly options: RequestInit;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let current: ReturnType<typeof detail>;
let calls: RequestCall[];
let handler: ((call: RequestCall) => Promise<Response> | Response | undefined) | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  current = detail();
  calls = [];
  handler = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const call = { url: String(input), options };
      calls.push(call);
      const handled = handler?.(call);
      if (handled) return handled;
      if (call.options.method === 'POST') {
        current = detail({ revision: 8, status: 'approved', actions: [] });
        return response(current);
      }
      if (call.url === `${API}/instances/${INSTANCE}`) return response(current);
      if (call.url.includes('/todos?'))
        return response({
          items: [{ instanceId: INSTANCE, taskId: TASK, title: current.title, nodeName: '经理审批' }],
        });
      return response({ items: [], page: 1, pageSize: 20 });
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(instanceId: string | null = INSTANCE, tenantId = TENANT) {
  const { ApprovalWorkspace } = await import(path);
  await act(async () => root.render(createElement(ApprovalWorkspace, { tenantId, instanceId })));
  if (instanceId) await vi.waitFor(() => expect(host.textContent).toContain(current.title));
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

async function input(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  expect(element, label).toBeTruthy();
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function writes() {
  return calls.filter((call) => call.options.method === 'POST');
}
function body(call: RequestCall) {
  return JSON.parse(String(call.options.body)) as Record<string, unknown>;
}

describe('AC-APV-UI-01 审批中心列表', () => {
  it('三列表使用待办、真正已处理、本人发起接口，分页与业务ID过滤不混用参与历史', async () => {
    handler = ({ url }) => {
      if (url.includes('/instances?'))
        return response({
          items: Array.from({ length: 20 }, (_, index) => ({
            id: INSTANCE,
            title: `合成已处理 ${index}`,
            status: 'running',
          })),
          page: 1,
          pageSize: 20,
        });
      return undefined;
    };
    await mount(null);
    await click('我已处理');
    await vi.waitFor(() => expect(host.textContent).toContain('合成已处理 0'));
    await click('下一页');
    expect(calls.some(({ url }) => url.includes('role=processed') && url.includes('page=2'))).toBe(true);
    await input('业务单 ID', ` ${BUSINESS.toUpperCase()} `);
    await click('筛选');
    expect(calls.some(({ url }) => url.includes(`businessId=${BUSINESS}`) && url.includes('page=1'))).toBe(true);
    await click('我发起的');
    expect(calls.some(({ url }) => url.includes('role=initiated'))).toBe(true);
    await click('我的待办');
    expect(calls.some(({ url }) => url.includes('/todos?'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('role=participated'))).toBe(false);
    expect(calls.filter(({ url }) => url.includes('/todos?')).every(({ url }) => !url.includes('businessId'))).toBe(
      true,
    );
  });

  it('非法业务单UUID只提示，不向接口发送无效筛选', async () => {
    await mount(null);
    await click('我发起的');
    await input('业务单 ID', 'invalid');
    await click('筛选');
    expect(host.textContent).toContain('有效的 UUID');
    expect(calls.some(({ url }) => url.includes('businessId=invalid'))).toBe(false);
  });
});

describe('AC-APV-UI-02 最小字段披露、进度与历史', () => {
  it('仅展示接口返回的嵌套值和原值，不补拉档案、业务单、流程配置；UTC展示事件时间', async () => {
    current = detail({
      form: {
        values: { contractFields: { number: '合成合同编号' }, effectiveDate: '2026-11-01' },
        originals: { contractFields: { number: '合成原编号' } },
        editMode: 'none',
        editableFields: [],
      },
      tasks: [{ id: TASK, nodeName: '合成会签节点', status: 'ended', origin: 'self_skip', isExceptionAdmin: true }],
      logs: [
        {
          id: 'log',
          event: 'admin_transfer',
          adminSelfTransfer: true,
          detail: { message: '合成管理员转交自审说明' },
          createdAt: '2026-10-07T12:34:56.000Z',
        },
      ],
    });
    await mount();
    for (const value of ['合成合同编号', '合成原编号', '合成会签节点', '合成管理员转交自审说明', '12:34:56'])
      expect(host.textContent).toContain(value);
    expect(host.textContent).not.toContain('salary');
    expect(host.textContent).not.toContain('bankAccount');
    expect(host.textContent).toContain('UTC');
    expect(calls.every(({ url }) => url.startsWith(API))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/processes') || url.includes('/businesses'))).toBe(false);
    await click('查看任务历史');
    expect(calls.some(({ url }) => url.includes(`/instances/${INSTANCE}/tasks?`))).toBe(true);
    await click('查看日志历史');
    expect(calls.some(({ url }) => url.includes(`/instances/${INSTANCE}/logs?`))).toBe(true);
  });

  it('recordsHidden隐藏历史且不请求分页历史，未公布动作没有按钮', async () => {
    current = detail({ recordsHidden: true, actions: ['transfer'], logs: [] });
    await mount();
    expect(host.textContent).toContain('审批记录已隐藏');
    for (const value of ['查看任务历史', '查看日志历史', '同意', '驳回', '管理员干预'])
      expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === value)).toBe(false);
    expect(calls.some(({ url }) => /\/(tasks|logs)\?/.test(url))).toBe(false);
  });
});

const actionCases = [
  { action: 'approve', label: '同意', path: `/tasks/${TASK}/approve`, payload: { comment: '合成意见' } },
  { action: 'disagree', label: '不同意', path: `/tasks/${TASK}/disagree`, payload: { comment: '合成意见' } },
  { action: 'reject', label: '驳回', path: `/tasks/${TASK}/reject`, payload: { comment: '合成意见' } },
  {
    action: 'transfer',
    label: '转交',
    path: `/tasks/${TASK}/transfer`,
    payload: { toUserId: USER, comment: '合成意见' },
  },
  {
    action: 'addSign',
    label: '加签',
    path: `/tasks/${TASK}/add-sign`,
    payload: { userIds: [USER], type: 'before', comment: '合成意见' },
  },
  { action: 'cc', label: '抄送', path: `/tasks/${TASK}/cc`, payload: { userIds: [USER], comment: '合成意见' } },
  { action: 'retrieve', label: '撤回我的审批', path: `/tasks/${RETRIEVE}/retrieve`, payload: {} },
  { action: 'withdraw', label: '撤销申请', path: `/instances/${INSTANCE}/withdraw`, payload: {} },
  { action: 'urge', label: '催办', path: `/instances/${INSTANCE}/urge`, payload: {} },
  { action: 'resubmit', label: '重新提交', path: `/instances/${INSTANCE}/resubmit`, payload: {} },
  {
    action: 'adminTransfer',
    label: '管理员转交',
    path: `/instances/${INSTANCE}/admin-transfer`,
    payload: { taskId: TASK, toUserId: USER, reason: '合成管理理由' },
  },
  {
    action: 'adminIntervene',
    label: '管理员干预',
    path: `/instances/${INSTANCE}/admin-intervene`,
    payload: { kind: 'reassign', taskId: TASK, toUserId: USER, reason: '合成管理理由' },
  },
] as const;

describe('AC-APV-UI-03 既有动作与账号输入', () => {
  it.each(actionCases)('$label ：按接口动作、实例revision和命令ID提交', async (test) => {
    current = detail({ actions: [test.action] });
    await mount();
    await click(test.label);
    if ('comment' in test.payload) await input('审批意见', '合成意见');
    if ('toUserId' in test.payload) await input('接收人用户账号 ID', ` ${USER.toUpperCase()} `);
    if ('userIds' in test.payload) await input('用户账号 ID 列表', ` ${USER.toUpperCase()} `);
    if ('reason' in test.payload) await input('管理理由', '合成管理理由');
    await click('确认提交');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.url).toBe(`${API}${test.path}`);
    expect(body(writes()[0]!)).toEqual(test.payload);
    const headers = new Headers(writes()[0]!.options.headers);
    expect(headers.get('if-match')).toBe('7');
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get('x-tenant-id')).toBe(TENANT);
  });

  it('管理员跳转只传接口支持的节点key，无须读取流程配置', async () => {
    current = detail({ actions: ['adminIntervene'] });
    await mount();
    await click('管理员干预');
    await input('干预方式', 'jump');
    await input('目标节点 key', 'synthetic-next');
    await input('管理理由', '合成跳转理由');
    await click('确认提交');
    expect(body(writes()[0]!)).toEqual({ kind: 'jump', toNodeKey: 'synthetic-next', reason: '合成跳转理由' });
    expect(calls.some(({ url }) => url.includes('/processes'))).toBe(false);
  });

  it('账号UUID无效时不发写请求或补拉员工候选', async () => {
    current = detail({ actions: ['transfer'] });
    await mount();
    await click('转交');
    await input('接收人用户账号 ID', 'invalid');
    await click('确认提交');
    expect(host.textContent).toContain('有效的 UUID');
    expect(writes()).toHaveLength(0);
    expect(calls.some(({ url }) => url.includes('/employees'))).toBe(false);
  });
});

describe('AC-APV-UI-04 并发、未知结果与权限失败', () => {
  it('409先回查刷新，保留意见并要求显式重提，新命令使用新revision', async () => {
    handler = (call) => {
      if (call.options.method !== 'POST') return undefined;
      if (writes().length === 1) {
        current = detail({ revision: 8 });
        return response({ error: { code: 'CONFLICT', message: 'revision已变化' } }, 409);
      }
      return response(detail({ revision: 9, status: 'approved', actions: [] }));
    };
    await mount();
    await click('同意');
    await input('审批意见', '合成保留意见');
    await click('确认提交');
    expect(writes()).toHaveLength(1);
    expect(host.textContent).toContain('显式重提');
    expect(calls.filter(({ url }) => url === `${API}/instances/${INSTANCE}`)).toHaveLength(2);
    await click('确认重新提交');
    expect(writes()).toHaveLength(2);
    expect(body(writes()[1]!)).toEqual({ comment: '合成保留意见' });
    expect(new Headers(writes()[1]!.options.headers).get('if-match')).toBe('8');
    expect(new Headers(writes()[1]!.options.headers).get('idempotency-key')).not.toBe(
      new Headers(writes()[0]!.options.headers).get('idempotency-key'),
    );
  });

  it('网络未知结果先回查，重试原命令保留ID、revision与载荷，不能用新命令重复操作', async () => {
    handler = (call) => {
      if (call.options.method === 'POST' && writes().length === 1) throw new TypeError('synthetic lost response');
      return undefined;
    };
    await mount();
    await click('同意');
    await input('审批意见', '合成未知结果意见');
    await click('确认提交');
    expect(host.textContent).toContain('结果待确认');
    expect(writes()).toHaveLength(1);
    expect(calls.filter(({ url }) => url === `${API}/instances/${INSTANCE}`)).toHaveLength(2);
    await click('重试原命令');
    expect(writes()).toHaveLength(2);
    expect(writes()[1]!.options.body).toEqual(writes()[0]!.options.body);
    for (const name of ['if-match', 'idempotency-key'])
      expect(new Headers(writes()[1]!.options.headers).get(name)).toBe(
        new Headers(writes()[0]!.options.headers).get(name),
      );
  });

  it.each([403, 404])('%i清除旧单和历史，显示统一权限提示', async (status) => {
    handler = (call) =>
      call.options.method === 'POST'
        ? response({ error: { code: 'FORBIDDEN', message: '不应把接口敏感文案当提示' } }, status)
        : undefined;
    await mount();
    await click('同意');
    await click('确认提交');
    expect(host.textContent).toContain('无权访问');
    expect(host.textContent).not.toContain('合成调动申请');
    expect(host.textContent).not.toContain('不应把接口敏感文案当提示');
    expect(host.textContent).not.toContain('经理审批');
  });

  it('同一个提交按钮双击只产生一个写命令', async () => {
    let finish!: (value: Response) => void;
    handler = (call) =>
      call.options.method === 'POST' ? new Promise<Response>((resolve) => (finish = resolve)) : undefined;
    await mount();
    await click('同意');
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === '确认提交')!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(writes()).toHaveLength(1);
    await act(async () => finish(response(detail({ actions: [], status: 'approved' }))));
  });

  it('租户切换时清除旧单；旧租户迟到响应不会恢复旧数据', async () => {
    let finish!: (value: Response) => void;
    handler = (call) => {
      if (call.url === `${API}/instances/${INSTANCE}`) return new Promise<Response>((resolve) => (finish = resolve));
      return undefined;
    };
    const { ApprovalWorkspace } = await import(path);
    await act(async () => root.render(createElement(ApprovalWorkspace, { tenantId: TENANT, instanceId: INSTANCE })));
    await act(async () => root.render(createElement(ApprovalWorkspace, { tenantId: 'second-tenant' })));
    await act(async () => finish(response(current)));
    expect(host.textContent).not.toContain('合成调动申请');
  });
});

describe('AC-APV-UI-05 审批中编辑', () => {
  it('separate只保存改动的可见可编辑字段与嵌套清空，独立保存不代为同意', async () => {
    current = detail({
      actions: ['edit', 'approve'],
      form: {
        values: { reason: '合成原理由', effectiveDate: '2026-11-01', contractFields: { number: '合成编号' } },
        editMode: 'separate',
        editableFields: ['reason', 'contractFields', 'hiddenSalary'],
      },
    });
    handler = (call) => (call.options.method === 'POST' ? response(detail({ revision: 8 })) : undefined);
    await mount();
    expect(host.querySelector('[aria-label="hiddenSalary"]')).toBeNull();
    expect(host.querySelector('[aria-label="effectiveDate"]')).toBeNull();
    await input('reason', '合成修正理由');
    await click('清空 contractFields.number');
    await click('编辑');
    await click('确认提交');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.url).toBe(`${API}/tasks/${TASK}/edit`);
    expect(body(writes()[0]!)).toEqual({ fields: { reason: '合成修正理由', contractFields: { number: null } } });
  });

  it('with_approve编辑随同意提交，未经修改的字段与隐藏的嵌套值都不补入载荷', async () => {
    current = detail({
      actions: ['approve'],
      form: {
        values: { reason: '合成原理由', contractFields: { number: '合成编号' } },
        editMode: 'with_approve',
        editableFields: ['reason', 'contractFields'],
      },
    });
    await mount();
    await click('清空 reason');
    await click('同意');
    await click('确认提交');
    expect(body(writes()[0]!)).toEqual({ comment: null, fields: { reason: null } });
    expect(writes()[0]!.url).toBe(`${API}/tasks/${TASK}/approve`);
  });
});
