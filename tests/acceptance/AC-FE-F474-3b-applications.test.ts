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
const { Applications } = await import(resolve('apps/web/src/approval/Applications.tsx'));
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
// 与 GET /api/tenant/approval/instances?view=applications 同形（AC-APV-F474-3b-applications 断言的固定键）
const running = {
  id: 'instance-running',
  title: '合成员工的调动申请',
  status: 'running',
  approvalType: 'transfer',
  approvalTypeName: '调动',
  initiatorName: '合成发起人甲',
  currentHandlers: ['合成审批人乙', '合成审批人丙'],
  createdAt: '2026-11-02T01:00:00Z',
};
const ended = { ...running, id: 'instance-ended', status: 'cancelled', currentHandlers: [], title: '合成终止调动' };
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
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function render() {
  const fetcher = vi.fn(
    async (_url: string) => new Response(JSON.stringify({ items: [running, ended], total: 27, page: 1, pageSize: 15 })),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(h(SessionProvider, { session }, h(MemoryRouter, { initialEntries: ['/'] }, h(Applications)))),
  );
  return fetcher;
}
const lastUrl = (fetcher: ReturnType<typeof vi.fn>) => new URL(String(fetcher.mock.calls.at(-1)![0]), 'http://x');
const headers = () => Array.from(host.querySelectorAll('thead th')).map((th) => th.textContent?.trim());

describe('AC-FE-F474-3b 我的申请列表呈现', () => {
  it('列序与列宽按原站 §2.10：无复选框与操作列，不再提示接口待补齐', async () => {
    await render();
    expect(headers()).toEqual(['标题', '类别', '发起人', '当前处理人', '审批状态', '申请理由', '申请时间']);
    const widths = Array.from(host.querySelectorAll('colgroup col')).map((col) => (col as HTMLElement).style.width);
    expect(widths).toEqual(['174px', '174px', '164px', '144px', '174px', '174px', '192px']);
    expect(host.querySelector('tbody input[type="checkbox"]')).toBeNull();
    expect(host.textContent).not.toContain('接口待补齐');
  });

  it('发起人带头像与姓名，当前处理人可多人、结束后为空；审批状态是深色普通文字', async () => {
    await render();
    const [first, second] = Array.from(host.querySelectorAll('tbody tr.ant-table-row')) as HTMLElement[];
    expect(first!.querySelectorAll('td')).toHaveLength(7);
    const cell = (row: HTMLElement, index: number) => row.querySelectorAll('td')[index]!;
    expect(cell(first!, 0).querySelector('button.approval-table-link')?.textContent).toBe('合成员工的调动申请');
    expect(cell(first!, 1).textContent).toBe('调动');
    expect(cell(first!, 2).querySelector('.approval-record-mark')?.textContent).toBe('人甲');
    expect(cell(first!, 2).textContent).toContain('合成发起人甲');
    expect(cell(first!, 3).textContent).toBe('合成审批人乙、合成审批人丙');
    expect(cell(second!, 3).textContent).toBe('--');
    expect(cell(first!, 4).textContent).toBe('审批中');
    expect(cell(second!, 4).textContent).toBe('已终止');
    expect(host.querySelector('tbody .ant-tag')).toBeNull();
    // 申请理由当前没有数据来源，不伪造，显示占位
    expect(cell(first!, 5).textContent).toBe('--');
    expect(cell(first!, 6).textContent).toBe('2026/11/02 09:00');
  });

  it('列表读服务端投影，总数取服务端而不是当前页条数', async () => {
    const fetcher = await render();
    const url = lastUrl(fetcher);
    expect(url.pathname).toBe('/api/tenant/approval/instances');
    expect(url.searchParams.get('view')).toBe('applications');
    expect(url.searchParams.get('role')).toBeNull();
    expect(url.searchParams.get('pageSize')).toBe('15');
    expect(host.querySelector('.page-total')?.textContent).toBe('共27条');
  });

  it('类别与审批状态是多选筛选，确认后带条件回到第 1 页重读', async () => {
    const fetcher = await render();
    const trigger = (label: string) =>
      Array.from(host.querySelectorAll('thead th'))
        .find((th) => th.textContent?.trim() === label)!
        .querySelector('.ant-table-filter-trigger') as HTMLElement;
    await act(() => trigger('审批状态').click());
    const options = () => Array.from(document.querySelectorAll('.ant-dropdown .ant-checkbox-wrapper'));
    expect(options().map((item) => item.textContent)).toEqual([
      '审批中',
      '通过',
      '不通过',
      '已终止',
      '已驳回',
      '已撤回',
    ]);
    await act(() => (options()[0] as HTMLElement).click());
    await act(() => (options()[3] as HTMLElement).click());
    const confirm = Array.from(document.querySelectorAll('.ant-dropdown button')).find((b) =>
      /确\s*定/.test(b.textContent ?? ''),
    ) as HTMLElement;
    await act(() => confirm.click());
    expect(lastUrl(fetcher).searchParams.get('status')).toBe('running,cancelled');
    expect(lastUrl(fetcher).searchParams.get('page')).toBe('1');
  });

  it('审批状态与申请时间列头点击后由服务端排序', async () => {
    const fetcher = await render();
    expect(lastUrl(fetcher).searchParams.get('sort')).toBeNull();
    const header = (label: string) =>
      Array.from(host.querySelectorAll('thead th')).find((th) => th.textContent?.trim() === label) as HTMLElement;
    await act(() => header('申请时间').click());
    expect(lastUrl(fetcher).searchParams.get('sort')).toBe('createdAt');
    await act(() => header('审批状态').click());
    expect(lastUrl(fetcher).searchParams.get('sort')).toBe('status');
    expect(lastUrl(fetcher).searchParams.get('order')).toBe('asc');
    await act(() => header('审批状态').click());
    expect(lastUrl(fetcher).searchParams.get('order')).toBe('desc');
  });
});
