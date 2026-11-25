/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F562（F-558 卡外遗留，DEC-954）HR 调动页：表单提示区只显示内核 refused 带出的本次拒绝。
 * 登记冲突、而占槽命令在本页处理拒绝前已落定时，内核不带 race 也不带 refused（store.ts submitTo），
 * 表单不能残留“其他标签页有该对象未确认的命令”；真正的等锁超时（refused）仍显示 DEC-954 专门文案、输入保留。
 * 别的标签页 A 的登记用“持锁期间写入共用记录”模拟（同 AC-FE-F110-29），A 落定即删掉记录。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
import { holdLock, installWebLocks } from './support/web-locks.js';

installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { useHrTransferCommand } = await import(resolve('apps/web/src/transfer/useHrTransferCommand.ts'));

const RECORDS = 'italent.commands.pending:transfer';
const TRANSFER_API = '/api/tenant/employment/transfers';
const EMPLOYEE = '85620000-0000-4000-8000-000000000001';
const SAVE_PATH = `${TRANSFER_API}/employees/${EMPLOYEE}`;
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCK_WAIT_MS = 3000;

const model: TransferFormModel = {
  initiator: 'hr',
  employees: [{ id: EMPLOYEE, code: 'DEMO-562', name: '合成调动人', revision: 3 }],
  departments: [],
  catalog: { today: '2026-11-24', types: [{ code: 'transfer', name: '部门间调动', formId: 'f' }], reasons: [] },
  employeeId: EMPLOYEE,
  effectiveDate: '2026-11-24',
  transferTypeCode: 'transfer',
  reasonCode: '',
  fields: { workPlace: '合成工作地' },
  customFields: {},
  contracts: [],
  preview: {
    form: {
      id: 'f',
      name: '部门间调动',
      isStandard: true,
      excludedAutofillFields: [],
      fieldModes: {},
      customFields: [],
    },
    fields: {},
    customFields: {},
    before: null,
    employeeRevision: 3,
    allowDirectTransfer: false,
    allowedActions: { application: true, directList: true, directRow: true },
  },
};
// POST /api/tenant/employment/transfers/employees/:id 的回执（调动单；员工版本已推进过 If-Match 3）。
const receipt = () => ({ id: randomUUID(), revision: 1, employeeRevision: 4, status: 'in_review' });

type Hr = ReturnType<typeof useHrTransferCommand>;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let hr: Hr;
let posts: string[];
let tenantId: string;
const setModel = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts = [];
  tenantId = randomUUID();
  setModel.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://local').pathname;
      if (init.method === 'POST' && path === SAVE_PATH) {
        posts.push(new Headers(init.headers).get('idempotency-key') ?? '');
        return Response.json(receipt());
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: '合成' } }, { status: 404 });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function Probe() {
  hr = useHrTransferCommand(tenantId, model, false, setModel);
  return h('p', { role: 'alert' }, hr.commandError);
}
async function render() {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () => root.render(h(SessionProvider, { session }, h(Probe))));
}
const scoped = (name: string) => JSON.stringify([tenantId, 'synthetic-user', name]);
/** 别的标签页 A 在锁内登记同一员工的命令（结果未知，占着本条目与调动集合槽）。 */
const registerA = () =>
  localStorage.setItem(
    RECORDS,
    JSON.stringify([
      { key: scoped(SAVE_PATH), slots: [scoped(TRANSFER_API)], commandId: 'synthetic-command-a', revision: 3 },
    ]),
  );
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? '';

describe('AC-FE-F562 HR 调动页登记冲突后占槽命令已落定', () => {
  it('B 登记被 A 的记录拒绝、处理拒绝前 A 已落定（内核不带 refused）：表单不残留其他标签页提示，可再提交', async () => {
    await render();
    const release = await holdLock(RECORDS); // A 持锁登记
    const request = navigator.locks.request.bind(navigator.locks);
    // 跨标签页交错：B 的登记读到 A 的记录被拒之后、B 处理这次拒绝之前，A 已收到回执并删掉记录。
    vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
      (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
        localStorage.removeItem(RECORDS);
        throw cause;
      }),
    );
    let submitted!: Promise<void>;
    await act(async () => {
      submitted = hr.submit('submit');
      await Promise.resolve();
    });
    registerA();
    release();
    await act(() => submitted);
    expect(posts).toEqual([]);
    expect(hr.commandError).toBe('');
    expect(alert()).not.toContain(OTHER_TAB);
    expect(hr.processingError).toBe('');
    expect(hr.processing).toBe(false);
    expect(hr.busy).toBe(false);

    // 没有锁定的命令：再提交照常发出一次。
    await act(() => hr.submit('submit'));
    expect(posts).toHaveLength(1);
    expect(hr.saved).toMatchObject({ status: 'in_review' });
    expect(hr.commandError).toBe('');
  });
});

describe('AC-FE-F562 正例', () => {
  it('他页一直持锁、等锁超时（refused）：表单显示 DEC-954 专门文案，零请求、输入保留，不锁定', async () => {
    await render();
    const release = await holdLock(RECORDS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let submitted!: Promise<void>;
      await act(async () => {
        submitted = hr.submit('submit');
        await Promise.resolve();
      });
      await act(() => vi.advanceTimersByTimeAsync(LOCK_WAIT_MS));
      await act(() => submitted);
    } finally {
      release();
    }
    expect(posts).toEqual([]);
    expect(hr.commandError).toBe(LOCK_BUSY);
    expect(alert()).toBe(LOCK_BUSY);
    expect(hr.processingError).toBe('');
    expect(hr.busy).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(model.fields).toEqual({ workPlace: '合成工作地' });
  });

  it('A 仍未确认时 B 提交：竞争原因随 A 的命令显示在处理中，表单提示区不重复', async () => {
    await render();
    registerA();
    await act(() => hr.submit('submit'));
    expect(posts).toEqual([]);
    expect(hr.processing).toBe(true);
    expect(hr.processingError).toBe(OTHER_TAB);
    expect(hr.commandError).toBe('');
  });

  it('单标签正常提交：发出一次、保存成功，无提示', async () => {
    await render();
    await act(() => hr.submit('submit'));
    expect(posts).toHaveLength(1);
    expect(hr.saved).toMatchObject({ status: 'in_review', employeeRevision: 4 });
    expect(hr.commandError).toBe('');
    expect(hr.processingError).toBe('');
    expect(localStorage.getItem(RECORDS)).toBeNull();
  });
});
