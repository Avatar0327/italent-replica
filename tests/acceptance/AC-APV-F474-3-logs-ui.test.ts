/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDetail as Detail } from '../../apps/web/src/approval/types.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
const detail: Detail = {
  id: 'synthetic-instance',
  title: '合成申请',
  revision: 2,
  status: 'running',
  approvalType: 'transfer',
  actions: [],
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-11-01' } },
  tasks: [],
  logs: [{ event: 'start', actorUserId: null, createdAt: '2026-11-01T00:00:00Z' }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === label)!;
async function render(todo = true, history: (page: number) => object = () => ({ items: [], recordsHidden: false })) {
  const fetcher = vi.fn(async (url: string) => {
    const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? 1);
    return new Response(JSON.stringify(url.includes('/logs?') ? { page, pageSize: 20, ...history(page) } : detail));
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(ApprovalDetail, {
          row: detail,
          layout: 'page',
          todo,
          onClose() {},
          onChanged() {},
        }),
      ),
    ),
  );
  return fetcher;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe('AC-APV-F474-3 完整流程日志与我的申请边界', () => {
  it('待办日志入口打开分页接口，不把详情近期日志当完整记录', async () => {
    const fetcher = await render(true, (page) => ({
      items:
        page === 1
          ? Array.from({ length: 20 }, (_, i) => ({
              event: 'approve',
              actorUserId: 'synthetic-actor',
              actorName: '合成审批人',
              detail: { comment: `分页意见 ${i}` },
              createdAt: '2026-11-01T01:00:00Z',
            }))
          : [
              {
                event: 'reject',
                actorUserId: null,
                detail: { comment: '更早意见' },
                createdAt: '2026-10-01T00:00:00Z',
              },
            ],
      recordsHidden: false,
    }));
    expect(button('查看流程日志').disabled).toBe(false);
    await click('查看流程日志');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('分页意见 19');
    expect(dialog.textContent).not.toContain('最近 200');
    expect(fetcher.mock.calls.at(-1)![0]).toBe(
      '/api/tenant/approval/instances/synthetic-instance/logs?page=1&pageSize=20',
    );
    await click('下一页');
    expect(dialog.textContent).toContain('更早意见');
    expect(dialog.textContent).not.toContain('分页意见');
    expect(button('下一页').disabled).toBe(true);
    await click('上一页');
    expect(dialog.textContent).toContain('分页意见 19');
  });
  it('隐藏回执不显示任何日志、姓名或翻页入口', async () => {
    await render(true, () => ({
      recordsHidden: true,
      items: [
        {
          event: 'approve',
          actorName: '不应呈现的合成姓名',
          detail: { comment: '隐藏意见' },
          createdAt: '2026-11-01T00:00:00Z',
        },
      ],
    }));
    expect(button('查看流程日志').disabled).toBe(false);
    await click('查看流程日志');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('当前查看人不可查看审批记录');
    expect(dialog.textContent).not.toContain('隐藏意见');
    expect(dialog.textContent).not.toContain('合成姓名');
    expect(dialog.textContent).not.toContain('下一页');
  });
  it('我的申请默认入口保持原有呈现与禁用日志入口，不新增请求', async () => {
    const fetcher = await render(false);
    expect(button('查看流程日志').disabled).toBe(true);
    expect(host.textContent).toContain('申请信息');
    expect(host.textContent).toContain('最近 200 条');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
