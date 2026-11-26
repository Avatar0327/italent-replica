/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F571（F-566 卡外遗留）HR 调动走表单内核的本次拒绝标记（foundation/forms/refusal-marks），与审批、组织调整同口径：
 * 标记模块级、同一存储上的各挂载实例共用（F-566 第 2 轮 P2-2）。同一员工挂两个 HR 调动表单实例（各自带真实
 * CommandStatus），实例 1 提交；登记冲突且 A 已在本页处理拒绝前落定、或 DEC-955 同步拒绝时，实例 2 的每一次 DOM 提交
 * 也不能渲染出这次被拒的条目（改前 HR 按挂载实例自己的处理中标记隐去，实例 2 会渲染出“其他标签页”旧告警）。
 * 处理完之后的提示仍只在实例 1 的表单原位置；A 的登记做法同 AC-FE-F562。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
import { holdLock, installWebLocks } from './support/web-locks.js';

const uninstallLocks = installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, useLayoutEffect, useRef } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { useHrTransferCommand } = await import(resolve('apps/web/src/transfer/useHrTransferCommand.ts'));
const { CommandStatus } = await import(resolve('apps/web/src/foundation/forms/CommandStatus.tsx'));

const RECORDS = 'italent.commands.pending:transfer';
const TRANSFER_API = '/api/tenant/employment/transfers';
const EMPLOYEE = '85710000-0000-4000-8000-000000000001';
const SAVE_PATH = `${TRANSFER_API}/employees/${EMPLOYEE}`;
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCKS_UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';

const model: TransferFormModel = {
  initiator: 'hr',
  employees: [{ id: EMPLOYEE, code: 'DEMO-571', name: '合成调动人', revision: 3 }],
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
let hrs: Hr[];
let posts: string[];
/** 每个实例每次 DOM 提交后的文字（含它的 CommandStatus）。 */
let commits: string[][];
let tenantId: string;
const setModel = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts = [];
  commits = [[], []];
  hrs = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

/** 排在实例最后：布局副作用在本次提交的 DOM 写完后才跑，读到的就是这次提交后该实例的文字。 */
function Commits({ index, section }: { index: number; section: { current: HTMLElement | null } }) {
  useLayoutEffect(() => {
    commits[index]!.push(section.current?.textContent ?? '');
  });
  return null;
}
function Probe({ index }: { index: number }) {
  const hr = useHrTransferCommand(tenantId, model, false, setModel);
  hrs[index] = hr;
  const section = useRef(null) as { current: HTMLElement | null };
  return h(
    'section',
    { ref: section, 'data-instance': index },
    h(CommandStatus, { submission: hr.conflict }),
    h('p', { role: 'alert' }, hr.commandError),
    h(Commits, { index, section }),
  );
}
async function render() {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () => root.render(h(SessionProvider, { session }, h(Probe, { index: 0 }), h(Probe, { index: 1 }))));
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
const text = (index: number) => host.querySelector(`[data-instance="${index}"]`)?.textContent ?? '';

describe('AC-FE-F571 HR 调动与审批、组织调整同口径：标记跨挂载实例共用', () => {
  it('登记冲突且 A 已落定：两个实例的每次 DOM 提交都没有旧告警，被拒条目随即清掉、零请求', async () => {
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
      submitted = hrs[0]!.submit('submit');
      await Promise.resolve();
    });
    registerA();
    release();
    await act(() => submitted);
    expect(posts).toEqual([]);
    for (const index of [0, 1]) {
      expect(commits[index]!.length).toBeGreaterThan(1);
      expect(commits[index]!.filter((page) => page.includes(OTHER_TAB))).toEqual([]);
      expect(text(index)).not.toContain(OTHER_TAB);
      expect(hrs[index]!.conflict.state).toBeUndefined();
      expect(hrs[index]!.commandError).toBe('');
      expect(hrs[index]!.busy).toBe(false);
    }
  });

  it('DEC-955 同步拒绝：提示只在提交实例的表单原位置，另一实例的状态区始终不显示，零请求', async () => {
    await render();
    uninstallLocks();
    try {
      await act(() => hrs[0]!.submit('submit'));
    } finally {
      installWebLocks();
    }
    expect(posts).toEqual([]);
    expect(hrs[0]!.commandError).toBe(LOCKS_UNSUPPORTED);
    expect(text(0)).toBe(LOCKS_UNSUPPORTED);
    expect(commits[1]!.filter((page) => page.includes(LOCKS_UNSUPPORTED))).toEqual([]);
    expect(text(1)).toBe('');
    for (const index of [0, 1]) expect(hrs[index]!.conflict.state).toBeUndefined();
  });
});
