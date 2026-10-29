// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { ui } from '../foundation/messages.js';
import { mailFixture } from '../../smoke/offer-mail-fixture.js';
import { OffersPage } from './OffersPage.js';

let host: HTMLDivElement;
let root: Root;
const tenantId = '10000000-0000-4000-8000-000000000001';
const elements = (selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent);
function mockResponse(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, { status }));
}
async function render(identityKey = 'synthetic-reader') {
  await act(async () => {
    root.render(
      h(SessionProvider, {
        session: { tenantId, identityKey, tenantName: '', timezone: '', displayName: '', source: 'server' },
        children: h(MemoryRouter, {
          initialEntries: [`/offers/${mailFixture.offerId}/mail`],
          children: h(Routes, {}, h(Route, { path: '/offers/*', element: h(OffersPage) })),
        }),
      }),
    );
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('AC-FE-F234 Offer 邮件详情', () => {
  it('四个分区及字段按原站顺序显示，真实 GET 携带租户且页面无业务按钮', async () => {
    const fetcher = mockResponse(mailFixture);
    await render();
    expect(elements('h1')).toEqual([mailFixture.name]);
    expect(elements('h2, h3')).toEqual(['Offer', '基本信息', '录用通知书', 'offer发送附件/抄送信息']);
    expect(elements('dt')).toEqual(['姓名', '个人邮箱', '主题', '附件', '抄送', '密送']);
    expect(elements('dd')).toEqual([
      mailFixture.name,
      mailFixture.recipient,
      '录用通知',
      '--',
      'copy@example.com',
      'blind@example.com',
    ]);
    expect(elements('.offer-mail-body p')).toEqual(mailFixture.notice.paragraphs);
    expect(host.querySelectorAll('button, input, textarea')).toHaveLength(0);
    expect(host.textContent).not.toMatch(/演示数据|发送历史|发送时间|发件人/);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/tenant/offers/${mailFixture.offerId}/mail`);
    expect(new Headers(options?.headers).get('x-tenant-id')).toBe(tenantId);
    expect(options?.credentials).toBe('same-origin');
    expect(options?.method ?? 'GET').toBe('GET');
  });
  it.each([null, []])('裁剪或空收件信息 %j 统一显示 --', async (empty) => {
    mockResponse({ ...mailFixture, recipient: null, cc: empty, bcc: empty });
    await render();
    expect(elements('dd')).toEqual([mailFixture.name, '--', '录用通知', '--', '--', '--']);
  });
  it('正文按纯文本逐段显示，不解析 HTML 或链接', async () => {
    const paragraphs = ['<img src=x onerror="alert(1)">', '<a href="https://example.com">接受</a>', '末段\n第二行'];
    mockResponse({ ...mailFixture, notice: { title: '录用通知书', paragraphs } });
    await render();
    expect(elements('.offer-mail-body p')).toEqual(paragraphs);
    expect(host.querySelector('.offer-mail-body img, .offer-mail-body a')).toBeNull();
  });
  it('404 OFFER_MAIL_NOT_SENT 显示约定空态', async () => {
    mockResponse({ error: { code: 'NOT_FOUND', details: { reason: 'OFFER_MAIL_NOT_SENT' } } }, 404);
    await render();
    expect(host.textContent).toContain('暂无Offer邮件');
    expect(host.textContent).not.toContain(ui.missing);
  });
  it('普通 404 保持通用不可见或不存在处理', async () => {
    mockResponse({ error: { code: 'NOT_FOUND' } }, 404);
    await render();
    expect(host.textContent).toContain(ui.missing);
    expect(host.textContent).not.toContain('暂无Offer邮件');
    expect(host.querySelector('h1')).toBeNull();
  });
  it('403 显示通用无权状态，不能误报未发送', async () => {
    mockResponse({ error: { code: 'FORBIDDEN' } }, 403);
    await render();
    expect(host.textContent).toContain(ui.denied);
    expect(host.textContent).not.toContain('暂无Offer邮件');
    expect(host.querySelector('.offer-mail-page')).toBeNull();
  });
  it('网络拒绝显示加载失败，不能误报未发送或无权', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    expect(host.textContent).toContain(ui.failed);
    expect(host.textContent).not.toContain('暂无Offer邮件');
    expect(host.textContent).not.toContain(ui.denied);
    expect(host.querySelector('.offer-mail-page')).toBeNull();
  });
  it('非 404 不因 reason 相同伪装成无邮件', async () => {
    mockResponse({ error: { code: 'UNAVAILABLE', details: { reason: 'OFFER_MAIL_NOT_SENT' } } }, 503);
    await render();
    expect(host.textContent).toContain(ui.failed);
    expect(host.textContent).not.toContain('暂无Offer邮件');
  });
  it('身份切换清除原邮件并忽略已取消请求的迟到响应', async () => {
    mockResponse(mailFixture);
    await render();
    expect(host.textContent).toContain(mailFixture.recipient);
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render('reader-two');
    expect(host.textContent).not.toContain(mailFixture.recipient);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
    await render('reader-three');
    await act(async () => resolveOld(Response.json(mailFixture)));
    expect(host.textContent).toContain(ui.missing);
    expect(host.textContent).not.toContain(mailFixture.recipient);
  });
});
