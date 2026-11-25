/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F558-2（F-558 ②，DEC-955）：调动联动详情的失败子项“重试”同样是调动写入。
 * http 非安全上下文（没有 navigator.locks，也没有 crypto.randomUUID）点重试：显示 DEC-955 文案、零请求，不重读联动；
 * 安全上下文（正例）：照常发出重试（带子项 revision 与命令 ID），并重新读取联动详情。
 * 页面按 TransferApplication 的联动详情区块装配（useLinkageDetail + LinkagePanel，错误显示在 role=alert）。
 * 夹具形状按后端：GET /transfers/:id/linkage（linkage/view.ts readTransferLinkage），子项 linkage/items.ts itemView。
 * 期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkagePanel } from './LinkagePanel.js';
import { useLinkageDetail } from './useLinkage.js';
import { installWebLocks } from '../../../../tests/acceptance/support/web-locks.js';

const BUSINESS = '85580000-0000-4000-8000-000000000021';
const ITEM = '85580000-0000-4000-8000-000000000031';
const LINKAGE_PATH = `/api/tenant/employment/transfers/${BUSINESS}/linkage`;
const RETRY_PATH = `/api/tenant/employment/transfers/linkage-items/${ITEM}/retry`;
const LOCKS_UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';

const failedItem = {
  id: ITEM,
  revision: 3,
  itemType: 'part_time_end',
  subordinateId: null,
  orgId: null,
  orgRole: null,
  relation: null,
  receiverId: null,
  partTimeRecordId: '85580000-0000-4000-8000-000000000041',
  effectiveDate: '2026-11-02',
  status: 'failed',
  attemptCount: 1,
  lastAttemptAt: '2026-11-02T01:00:00.000Z',
  failure: { code: 'PART_TIME_LOCKED', message: '合成兼职记录被锁定', rule: null },
};
const linkage = (item: Record<string, unknown>) => ({
  businessId: BUSINESS,
  revision: 2,
  options: null,
  executedAt: '2026-11-02T01:00:00.000Z',
  contract: null,
  onTrial: null,
  handover: null,
  dutyTransfer: null,
  partTimes: [item],
  insuranceArchive: null,
  salaryReminder: null,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let requests: { method: string; path: string; headers: Headers }[];
let restoreLocks: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://local').pathname;
      const method = init.method ?? 'GET';
      requests.push({ method, path, headers: new Headers(init.headers) });
      const retried = requests.some((request) => request.method === 'POST');
      const body =
        method === 'POST'
          ? { ...failedItem, revision: 4, status: 'succeeded', attemptCount: 2, failure: null }
          : linkage(
              retried
                ? { ...failedItem, revision: 4, status: 'succeeded', attemptCount: 2, failure: null }
                : failedItem,
            );
      return Response.json(body);
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
  restoreLocks?.();
  restoreLocks = undefined;
  vi.unstubAllGlobals();
});

/** 与 TransferApplication 的联动详情区块相同的装配：错误在 role=alert，失败子项给“重试”。 */
function LinkageDetail({ tenantId }: { tenantId: string }) {
  const detail = useLinkageDetail(tenantId, BUSINESS);
  return h(
    'div',
    null,
    detail.error ? h('p', { role: 'alert' }, detail.error) : null,
    detail.view
      ? h(LinkagePanel, { view: detail.view, busy: detail.busy, onRetry: (item) => void detail.retry(item) })
      : null,
  );
}
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function open() {
  await act(async () => root.render(h(LinkageDetail, { tenantId: randomUUID() })));
  await settle(20);
  expect(host.querySelector(`[data-retry-item="${ITEM}"]`), '失败子项已显示').not.toBeNull();
}
async function retry() {
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-retry-item="${ITEM}"]`)!.click());
  await settle(20);
}
const reads = () => requests.filter((request) => request.method === 'GET' && request.path === LINKAGE_PATH).length;
const writes = () => requests.filter((request) => request.method !== 'GET');

describe('AC-FE-F558-2 联动重试纳入 DEC-955 拦截', () => {
  it('非安全上下文：点重试显示需 https 文案、零请求、不重读，按钮仍可再点', async () => {
    // http 页面：浏览器不提供 navigator.locks 与 crypto.randomUUID（getRandomValues 仍在）。
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await open();
    expect(reads()).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await retry();
      expect(host.querySelector('p[role="alert"]')?.textContent).toBe(LOCKS_UNSUPPORTED);
      expect(host.querySelector<HTMLButtonElement>(`[data-retry-item="${ITEM}"]`)?.disabled).toBe(false);
    }
    expect(writes()).toEqual([]);
    expect(reads()).toBe(1);
  });

  it('正例：安全上下文点重试照常发出（子项 revision + 命令 ID），并重读联动详情', async () => {
    restoreLocks = installWebLocks();
    await open();
    await retry();
    expect(writes()).toHaveLength(1);
    const [write] = writes();
    expect(write).toMatchObject({ method: 'POST', path: RETRY_PATH });
    expect(write!.headers.get('if-match')).toBe('3');
    expect(write!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(reads()).toBe(2);
    expect(host.querySelector('p[role="alert"]')).toBeNull();
    expect(host.querySelector(`[data-retry-item="${ITEM}"]`)).toBeNull();
  });
});
