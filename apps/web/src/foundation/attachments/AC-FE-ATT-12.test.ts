// @vitest-environment happy-dom
/**
 * F-479 S4 AC-FE-ATT-12：带租户头的二进制读取（设计 §5.4）。
 * useAttachmentBlob：加载中卸载、换 tenantId / path、请求失败；downloadAttachment：成功与失败。
 * 内容响应头照 attachments/routes.ts 的内容出口（Content-Disposition attachment、nosniff、CSP sandbox、no-store）。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorBody, pngBytes } from '../../../smoke/attachment-fixtures.js';
import { downloadAttachment, useAttachmentBlob, useAttachmentDownload } from './blob.js';

const TENANT_A = '55555555-5555-4555-8555-555555555555';
const TENANT_B = '66666666-6666-4666-8666-666666666666';
const FILE_1 = '77777777-7777-4777-8777-000000000001';
const FILE_2 = '77777777-7777-4777-8777-000000000002';
const temporaryPath = (id: string) => `/api/tenant/attachments/${id}/content`;
const approvalPath = (id: string) =>
  `/api/tenant/approval/instances/88888888-8888-4888-8888-888888888888/attachments/${id}/content`;

interface Pending {
  path: string;
  headers: Headers;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}
let pending: Pending[];
let created: string[];
let revoked: string[];
let container: HTMLDivElement;
let root: Root | undefined;

const image = () =>
  new Response(pngBytes() as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-disposition': 'attachment; filename="_.png"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
const notFound = () => Response.json(errorBody('NOT_FOUND', '附件不存在'), { status: 404 });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = [];
  created = [];
  revoked = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input, init = {}) =>
      new Promise<Response>((resolve, reject) => {
        const entry = { path: String(input), headers: new Headers(init.headers), init, resolve, reject };
        pending.push(entry);
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:合成/${created.length + 1}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(() => Promise.resolve());
}
function Probe({ tenantId, path }: { tenantId: string; path: string }) {
  const state = useAttachmentBlob(tenantId, path);
  if (state.status === 'ready') return h('img', { src: state.url, alt: '缩略图' });
  return h('span', { className: state.status }, state.status === 'failed' ? '加载失败' : '加载中');
}
async function render(tenantId: string, path: string) {
  root ??= createRoot(container);
  await act(async () => root!.render(h(Probe, { tenantId, path })));
}
const img = () => container.querySelector('img');

describe('AC-FE-ATT-12 useAttachmentBlob', () => {
  it('请求带 x-tenant-id 与 same-origin 凭据；成功后以 Blob 地址渲染', async () => {
    await render(TENANT_A, temporaryPath(FILE_1));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.path).toBe(temporaryPath(FILE_1));
    expect(pending[0]!.headers.get('x-tenant-id')).toBe(TENANT_A);
    expect(pending[0]!.init.credentials).toBe('same-origin');
    pending[0]!.resolve(image());
    await flush();
    expect(img()?.getAttribute('src')).toBe('blob:合成/1');
  });

  it('加载中卸载：请求被 abort，迟到的响应不建 Blob 地址', async () => {
    await render(TENANT_A, temporaryPath(FILE_1));
    const signal = pending[0]!.init.signal!;
    act(() => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
    pending[0]!.resolve(image());
    await flush();
    expect(created).toEqual([]);
  });

  it('换 path：旧地址 revoke、旧图不再显示，新请求按新路径；换 tenantId：旧请求 abort、新请求带新租户头', async () => {
    await render(TENANT_A, temporaryPath(FILE_1));
    pending[0]!.resolve(image());
    await flush();
    expect(img()?.getAttribute('src')).toBe('blob:合成/1');

    await render(TENANT_A, approvalPath(FILE_2));
    expect(revoked).toEqual(['blob:合成/1']);
    expect(img()).toBeNull();
    expect(pending[1]!.path).toBe(approvalPath(FILE_2));

    await render(TENANT_B, approvalPath(FILE_2));
    expect(pending[1]!.init.signal!.aborted).toBe(true);
    expect(pending[2]!.headers.get('x-tenant-id')).toBe(TENANT_B);
    pending[1]!.resolve(image());
    pending[2]!.resolve(image());
    await flush();
    expect(created).toEqual(['blob:合成/1', 'blob:合成/2']);
    expect(img()?.getAttribute('src')).toBe('blob:合成/2');
  });

  it('请求失败（404 / 网络错误）：置为失败，不保留上一张图', async () => {
    await render(TENANT_A, temporaryPath(FILE_1));
    pending[0]!.resolve(image());
    await flush();
    await render(TENANT_A, temporaryPath(FILE_2));
    pending[1]!.resolve(notFound());
    await flush();
    expect(img()).toBeNull();
    expect(container.textContent).toBe('加载失败');
    expect(created).toEqual(['blob:合成/1']);
    expect(revoked).toEqual(['blob:合成/1']);

    await render(TENANT_A, approvalPath(FILE_1));
    pending[2]!.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(container.textContent).toBe('加载失败');
  });

  it('不是附件内容接口的路径不发请求，直接失败', async () => {
    await render(TENANT_A, '/api/tenant/employees/77777777-7777-4777-8777-000000000001');
    await flush();
    expect(pending).toHaveLength(0);
    expect(container.textContent).toBe('加载失败');
  });
});

describe('AC-FE-ATT-12 downloadAttachment', () => {
  it('成功：带头读取 → 不挂载的 <a download> 点击 → 下一拍释放地址', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    const done = downloadAttachment(TENANT_A, approvalPath(FILE_1), '手写离职申请.png');
    expect(pending[0]!.headers.get('x-tenant-id')).toBe(TENANT_A);
    pending[0]!.resolve(image());
    await done;
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.getAttribute('download')).toBe('手写离职申请.png');
    expect(clicks[0]!.getAttribute('href')).toBe('blob:合成/1');
    expect(clicks[0]!.isConnected).toBe(false);
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(['blob:合成/1']);
  });

  it('失败：拒绝、不点击、不建地址', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const done = downloadAttachment(TENANT_A, approvalPath(FILE_1), '失败.png');
    pending[0]!.resolve(notFound());
    await expect(done).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('useAttachmentDownload：请求期间禁用；释放前卸载也释放地址；请求中卸载会 abort；失败给出中文提示', async () => {
    // 假定时器固定“下一拍释放”的时机：真定时器下 await act 可能让出宏任务，释放先于卸载发生，用例失真
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let api: ReturnType<typeof useAttachmentDownload> | undefined;
    function Button() {
      api = useAttachmentDownload(TENANT_A);
      return h('span', null, api.error ?? (api.pending ? '下载中' : '空闲'));
    }
    root = createRoot(container);
    await act(async () => root!.render(h(Button)));
    let done: Promise<unknown> | undefined;
    act(() => void (done = api!.download(approvalPath(FILE_1), '甲.png')));
    expect(api!.pending).toBe(true);
    pending[0]!.resolve(notFound());
    await act(() => done!);
    expect(container.textContent).toBe('下载失败，请重试');
    expect(api!.pending).toBe(false);

    act(() => void (done = api!.download(approvalPath(FILE_1), '甲.png')));
    pending[1]!.resolve(image());
    await act(() => done!);
    expect(created).toEqual(['blob:合成/1']);
    expect(revoked).toEqual([]);
    act(() => void api!.download(approvalPath(FILE_2), '乙.png'));
    const signal = pending[2]!.init.signal!;
    act(() => root!.unmount());
    root = undefined;
    expect(revoked).toEqual(['blob:合成/1']);
    expect(signal.aborted).toBe(true);
  });
});
