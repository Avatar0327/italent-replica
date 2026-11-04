/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { TodoCenter } = await import(resolve('apps/web/src/approval/TodoCenter.tsx'));
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
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
async function render(view: string) {
  const fetcher = vi.fn(
    async (_url: string) =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'instance',
              instanceId: 'instance',
              taskId: 'task',
              title: '合成调动',
              approvalType: 'transfer',
              initiatorName: '合成发起人甲',
              summary: [{ key: 'effectiveDate', label: '调动日期', value: '2026-11-02' }],
              createdAt: '2026-11-01T00:00:00Z',
            },
          ],
          total: 27,
          categories: [{ key: 'employment', label: '人事变动', count: 27 }],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(MemoryRouter, { initialEntries: [`/?view=${view}`] }, h(TodoCenter, { visible: ['todos'] })),
      ),
    ),
  );
  return fetcher;
}
describe('AC-APV-F474-3 待办卡片不使用当前页推算计数', () => {
  it('发起人、业务摘要与服务端分类总数一起呈现', async () => {
    await render('pending');
    expect(host.querySelector('.approval-card-title')?.textContent).toContain('合成发起人甲');
    expect(host.querySelector('.approval-record-meta')?.textContent).toContain('调动日期：2026-11-02');
    expect(host.querySelector('.approval-categories')?.textContent).toContain('人事变动27');
    expect(host.querySelector('.approval-categories')?.textContent).toContain('待处理27');
  });
  it.each(['initiated', 'completed'])('%s 卡片独立读真实待办接口，不改变我的申请实例查询', async (view) => {
    const fetcher = await render(view);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain(`/api/tenant/approval/todos?view=${view}`);
    expect(host.textContent).not.toContain('演示数据');
    expect(host.textContent).toContain('合成发起人甲');
  });
});
