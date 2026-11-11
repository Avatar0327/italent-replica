// @vitest-environment happy-dom
import { createElement as h, act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageCenter } from './HeaderParts.js';
import { SessionProvider, type Session } from './Session.js';

const session: Session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  displayName: '合成操作人',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
const notice = (id: string, extra = {}) => ({
  id,
  channel: 'inbox',
  title: `通知${id}`,
  body: `正文${id}`,
  sender: '合成提交人',
  template: 'exit_import_finished',
  businessId: id,
  createdAt: '2026-11-05T20:30:00Z',
  ...extra,
});
const reply = (items: unknown[], page = 1, pageSize = 20) => Response.json({ items, page, pageSize });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fetcher: ReturnType<typeof vi.fn>;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent?.replace(/\s/g, '') === label || el.getAttribute('aria-label') === label,
  )!;
const click = async (label: string) => {
  await act(async () => button(label).click());
};
const render = async () => {
  await act(async () => root.render(h(SessionProvider, { session, children: h(MessageCenter) })));
};
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetcher = vi.fn().mockResolvedValue(reply([]));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('FE-08 打开请求一次，按后端顺序过滤，发送人、模板链接与租户时区', async () => {
  fetcher.mockResolvedValue(
    reply([
      notice('1'),
      notice('2', { channel: 'email' }),
      notice('3', { body: null }),
      notice('4', { template: 'exit_import_finished_clean' }),
      notice('5', { template: 'flow_terminated_by_exit', sender: null }),
      notice('6', { body: '' }),
    ]),
  );
  await render();
  expect(fetcher).not.toHaveBeenCalled();
  await click('消息');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe('/api/tenant/approval/notifications?page=1');
  const drawer = document.querySelector('.message-drawer')!;
  expect(drawer.textContent).toContain('正文1');
  expect(drawer.textContent).toContain('正文4');
  expect(drawer.textContent).toContain('正文5');
  expect(drawer.textContent).not.toContain('正文2');
  expect(drawer.textContent).not.toContain('通知3');
  expect(drawer.textContent).not.toContain('通知6');
  expect(drawer.textContent?.match(/发送人：合成提交人/g)).toHaveLength(2);
  expect(drawer.textContent?.match(/查看详情/g)).toHaveLength(1);
  expect(drawer.textContent).toContain('2026/11/06 04:30');
  const tabs = [...drawer.querySelectorAll<HTMLElement>('[role=tab]')];
  await act(() => tabs.find((el) => el.textContent === '@和回复我的')!.click());
  expect(drawer.querySelector('.ant-tabs-tabpane-active')?.textContent).toContain('暂无新消息');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('FE-08 分页依据原始页长度，追加保持顺序，末页结束', async () => {
  fetcher
    .mockResolvedValueOnce(reply([notice('1', { channel: 'email' }), notice('2', { body: null })], 1, 2))
    .mockResolvedValueOnce(reply([notice('3'), notice('4')], 2, 2))
    .mockResolvedValueOnce(reply([notice('5')], 3, 2));
  await render();
  await click('消息');
  await click('加载更多');
  await click('加载更多');
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual(
    [1, 2, 3].map((p) => `/api/tenant/approval/notifications?page=${p}`),
  );
  const text = document.querySelector('.message-drawer')!.textContent!;
  expect(text.indexOf('正文3')).toBeLessThan(text.indexOf('正文4'));
  expect(text.indexOf('正文4')).toBeLessThan(text.indexOf('正文5'));
  expect(button('加载更多')).toBeUndefined();
});

it('FE-08 关闭后旧响应丢弃，重开只采用最后一次请求', async () => {
  const old = deferred();
  const latest = deferred();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  await render();
  await click('消息');
  await act(() => document.querySelector<HTMLButtonElement>('.ant-drawer-close')!.click());
  await click('消息');
  await act(async () => latest.resolve(reply([notice('新')])));
  await act(async () => old.resolve(reply([notice('旧')])));
  expect(document.querySelector('.message-drawer')!.textContent).toContain('正文新');
  expect(document.querySelector('.message-drawer')!.textContent).not.toContain('正文旧');
});

it('FE-08 关闭响应到达后再次打开重新请求，卸载响应丢弃', async () => {
  const old = deferred();
  fetcher.mockReturnValueOnce(old.promise).mockResolvedValueOnce(reply([]));
  await render();
  await click('消息');
  await act(() => document.querySelector<HTMLButtonElement>('.ant-drawer-close')!.click());
  await act(async () => old.resolve(reply([notice('关闭后')])));
  await click('消息');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.message-drawer')!.textContent).not.toContain('正文关闭后');
  const late = deferred();
  fetcher.mockReturnValueOnce(late.promise);
  await act(() => document.querySelector<HTMLButtonElement>('.ant-drawer-close')!.click());
  await click('消息');
  await act(() => root.render(null));
  await act(async () => late.resolve(reply([notice('卸载后')])));
  expect(document.body.textContent).not.toContain('正文卸载后');
});

it.each([
  [404, 'EXIT_IMPORT_FILE_EXPIRED', '文件已过期'],
  [403, 'FORBIDDEN', '下载失败，请重试'],
  [500, 'SERVER_ERROR', '下载失败，请重试'],
])('FE-08 下载错误 %s 仅中文提示', async (status, code, message) => {
  fetcher
    .mockResolvedValueOnce(reply([notice('batch')]))
    .mockResolvedValueOnce(Response.json({ error: { code, message: code } }, { status: Number(status) }));
  await render();
  await click('消息');
  await click('查看详情');
  expect(fetcher.mock.calls[1]![0]).toBe('/api/tenant/employment/exits/import/batches/batch/error-file');
  expect(document.querySelector('[role=alert]')?.textContent).toContain(message);
  expect(document.body.textContent).not.toContain(code);
});

it('FE-08 blob 下载取响应文件名，重复点击只发一次，释放 URL', async () => {
  const pending = deferred();
  fetcher.mockResolvedValueOnce(reply([notice('batch')])).mockReturnValueOnce(pending.promise);
  const create = vi.fn(() => 'blob:synthetic');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  await render();
  await click('消息');
  await click('查看详情');
  await click('查看详情');
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () =>
    pending.resolve(
      new Response('xlsx', {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition':
            `attachment; filename="fallback.xlsx"; filename*=UTF-8''` + encodeURIComponent('下载导入错误报告.xlsx'),
        },
      }),
    ),
  );
  expect(downloads).toEqual(['下载导入错误报告.xlsx']);
  expect(create).toHaveBeenCalledTimes(1);
  await new Promise((done) => setTimeout(done, 10));
  expect(revoke).toHaveBeenCalledWith('blob:synthetic');
});

it('FE-08 列表失败显示中文，可重试，空集显示空状态', async () => {
  fetcher
    .mockResolvedValueOnce(Response.json({ error: { code: 'SERVER_ERROR', message: 'SERVER_ERROR' } }, { status: 500 }))
    .mockResolvedValueOnce(reply([]));
  await render();
  await click('消息');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('消息加载失败，请重试');
  expect(document.body.textContent).not.toContain('SERVER_ERROR');
  await click('重试');
  expect(document.querySelector('.message-drawer')?.textContent).toContain('暂无新消息');
});

it('FE-08 正常入口 StrictMode 打开只请求一次', async () => {
  await act(async () => root.render(h(StrictMode, {}, h(SessionProvider, { session, children: h(MessageCenter) }))));
  await click('消息');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('FE-08 第二页失败重试保留已加载条目，不跳页或重复追加', async () => {
  fetcher
    .mockResolvedValueOnce(reply([notice('1')], 1, 1))
    .mockRejectedValueOnce(new Error('NETWORK_FAILURE'))
    .mockResolvedValueOnce(reply([notice('2')], 2, 2));
  await render();
  await click('消息');
  await click('加载更多');
  expect(document.body.textContent).toContain('正文1');
  expect(document.body.textContent).not.toContain('NETWORK_FAILURE');
  await click('重试');
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual(
    [1, 2, 2].map((p) => `/api/tenant/approval/notifications?page=${p}`),
  );
  expect(document.querySelector('.notification-list')?.textContent?.match(/正文1/g)).toHaveLength(1);
  expect(document.body.textContent).toContain('正文2');
});

it('FE-08 关闭后下载响应丢弃，通知内容按纯文本展示', async () => {
  const pending = deferred();
  fetcher
    .mockResolvedValueOnce(reply([notice('batch', { body: '<img src=x onerror=alert(1)>', sender: '<提交人>' })]))
    .mockReturnValueOnce(pending.promise);
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await render();
  await click('消息');
  expect(document.querySelector('.notification-body img')).toBeNull();
  expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  await click('查看详情');
  await act(() => document.querySelector<HTMLButtonElement>('.ant-drawer-close')!.click());
  await act(async () =>
    pending.resolve(
      new Response('xlsx', {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      }),
    ),
  );
  expect(anchor).not.toHaveBeenCalled();
});

it('FE-08 切租户丢弃旧响应，读取与下载都携带当前租户', async () => {
  const old = deferred();
  fetcher
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(reply([notice('新租户')]))
    .mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  await render();
  await click('消息');
  const nextSession = { ...session, tenantId: 'synthetic-other', identityKey: 'synthetic-other-user' };
  await act(async () => root.render(h(SessionProvider, { session: nextSession, children: h(MessageCenter) })));
  await act(async () => old.resolve(reply([notice('旧租户')])));
  expect(document.body.textContent).not.toContain('正文旧租户');
  expect(document.body.textContent).toContain('正文新租户');
  await click('查看详情');
  expect(new Headers(fetcher.mock.calls[1]![1].headers).get('x-tenant-id')).toBe('synthetic-other');
  expect(new Headers(fetcher.mock.calls[2]![1].headers).get('x-tenant-id')).toBe('synthetic-other');
  expect(document.querySelector('[role=alert]')?.textContent).toBe('下载失败，请重试');
  expect(document.body.textContent).not.toContain('NOT_FOUND');
});
