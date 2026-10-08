/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const componentPath = resolve('apps/web/src/talent/PotentialModelImage.tsx');
const BASE = '/api/tenant/talent/criteria/criterion/model-image';
const MAX_BYTES = 5 * 1024 * 1024;

interface ImageMetadata {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  status: 'registered' | 'uploaded';
}
interface RecordedRequest {
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let mounted: boolean;
let revision: number;
let canEdit: boolean;
let current: ImageMetadata | null;
let pending: ImageMetadata | null;
let nextId: number;
let failRead: boolean;
let failUpload: boolean;
let unknownUpload: boolean;
let requests: RecordedRequest[];
let recordedResults: Map<string, unknown>;
const createUrl = vi.fn<(blob: Blob) => string>();
const revokeUrl = vi.fn<(url: string) => void>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function image(id = 'existing'): ImageMetadata {
  return {
    id,
    filename: 'existing.png',
    contentType: 'image/png',
    byteSize: 4,
    sha256: '00'.repeat(32),
    status: 'uploaded',
  };
}

/** 服务端契约：登记、上传、删除都递增标准 revision；重放返回原结果。 */
async function mockFetch(input: string | URL | Request, init: RequestInit = {}) {
  const path = String(input);
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  requests.push({ path, method, headers, body });
  if (method === 'GET' && path === BASE) {
    if (failRead) return json({ error: { code: 'FORBIDDEN', message: '无权查看人才标准' } }, 403);
    return json({ revision, canEdit, modelImage: current });
  }
  if (method === 'GET' && path.endsWith('/content')) {
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  }
  const key = headers.get('idempotency-key') ?? '';
  if (recordedResults.has(key)) return json(recordedResults.get(key));
  if (method === 'POST' && path === `${BASE}/attachments`) {
    pending = { ...(body as unknown as ImageMetadata), id: `image-${++nextId}`, status: 'registered' };
    revision += 1;
    const result = { revision, attachment: pending };
    recordedResults.set(key, result);
    return json(result, 201);
  }
  if (method === 'POST' && path.endsWith('/upload')) {
    if (failUpload) return json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '图片内容不合法' } }, 415);
    current = { ...pending!, status: 'uploaded' };
    revision += 1;
    const result = { revision, canEdit, modelImage: current };
    recordedResults.set(key, result);
    if (unknownUpload) {
      unknownUpload = false;
      throw new TypeError('network disconnected');
    }
    return json(result);
  }
  if (method === 'DELETE' && path === BASE) {
    current = null;
    revision += 1;
    const result = { revision, canEdit, modelImage: null };
    recordedResults.set(key, result);
    return json(result);
  }
  throw new Error(`未登记的 UI 请求：${method} ${path}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  revision = 1;
  canEdit = true;
  current = null;
  pending = null;
  nextId = 0;
  failRead = false;
  failUpload = false;
  unknownUpload = false;
  requests = [];
  recordedResults = new Map();
  createUrl.mockReset().mockImplementation(() => `blob:model-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('fetch', vi.fn(mockFetch));
  vi.stubGlobal('crypto', {
    randomUUID: () => `command-${requests.length}-${Math.random()}`,
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(locked = false) {
  const { PotentialModelImage } = (await import(componentPath)) as { PotentialModelImage: unknown };
  await act(async () =>
    root.render(createElement(PotentialModelImage, { tenantId: 'tenant', criterionId: 'criterion', locked })),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('潜力概览'));
  await vi.waitFor(() => expect(requests.some((request) => request.path === BASE)).toBe(true));
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
}

async function click(label: string) {
  expect(button(label), label).toBeTruthy();
  await act(async () => button(label)!.click());
}

async function selectFile(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  Object.defineProperty(input!, 'files', { configurable: true, value: [file] });
  await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true })));
}

function file(bytes = 4, name = 'model.png', contentType = 'image/png') {
  const data = new Uint8Array(bytes);
  const result = new File([data], name, { type: contentType });
  Object.defineProperty(result, 'arrayBuffer', { value: async () => data.buffer });
  return result;
}

async function upload(newFile = file(), replacing = false) {
  await click(replacing ? '替换模型图' : '模型图设置');
  await selectFile(newFile);
  await click('保存');
  await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
}

function writes() {
  return requests.filter((request) => request.method !== 'GET');
}

describe('AC-TC-MODEL-UI 潜力模型静态图片操作', () => {
  it('上传、替换、删除按服务端 revision 串联，显示模型图并释放旧图片 URL', async () => {
    await render();
    expect(host.querySelector('img')).toBeNull();
    await upload();
    const firstUrl = host.querySelector('img')!.getAttribute('src');
    await upload(file(5, 'replacement.jpg', 'image/jpeg'), true);
    await vi.waitFor(() => expect(host.querySelector('img')!.getAttribute('src')).not.toBe(firstUrl));
    expect(revokeUrl).toHaveBeenCalledWith(firstUrl);
    const secondUrl = host.querySelector('img')!.getAttribute('src');
    await click('删除模型图');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeNull());
    expect(revokeUrl).toHaveBeenCalledWith(secondUrl);
    expect(writes().map((request) => request.headers.get('if-match'))).toEqual(['1', '2', '3', '4', '5']);
    expect(writes().map((request) => request.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'DELETE']);
    expect(writes()[0]!.body).toMatchObject({ filename: 'model.png', contentType: 'image/png', byteSize: 4 });
    expect(writes()[1]!.body).toEqual({ base64: 'AAAAAA==' });
    for (const request of writes()) {
      expect(request.headers.get('x-tenant-id')).toBe('tenant');
      expect(request.headers.get('idempotency-key')).toBeTruthy();
    }
  });

  it('没有编辑权仍可查看，模型图设置、替换和删除没有可执行按钮', async () => {
    canEdit = false;
    current = image();
    await render();
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    for (const label of ['模型图设置', '替换模型图', '删除模型图']) {
      const control = button(label);
      expect(control === undefined || control.disabled).toBe(true);
    }
    expect(writes()).toEqual([]);
  });

  it.each([
    { label: '不支持的格式', value: () => file(4, 'model.svg', 'image/svg+xml'), reason: '格式' },
    { label: '超过 5MiB', value: () => file(MAX_BYTES + 1), reason: '5M' },
  ])('$label 时明确提示且不登记附件', async ({ value, reason }) => {
    await render();
    await click('模型图设置');
    await selectFile(value());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(reason);
    expect(writes()).toEqual([]);
    expect(button('保存')?.disabled).toBe(true);
  });

  it('刚好 5MiB 可以上传，文件选择器声明所有允许的扩展名', async () => {
    await render();
    await click('模型图设置');
    const accept = host.querySelector<HTMLInputElement>('input[type="file"]')!.accept;
    for (const extension of ['.jpeg', '.jpg', '.gif', '.png', '.bmp']) expect(accept).toContain(extension);
    await selectFile(file(MAX_BYTES));
    expect(button('保存')?.disabled).toBe(false);
    await click('保存');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(writes()[0]!.body?.byteSize).toBe(MAX_BYTES);
  });

  it('服务器明确拒绝上传时保留原图，显示具体错误且不提供原请求重试', async () => {
    current = image();
    await render();
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    const originalUrl = host.querySelector('img')!.getAttribute('src');
    failUpload = true;
    await click('替换模型图');
    await selectFile(file());
    await click('保存');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('图片内容不合法'));
    expect(host.querySelector('img')!.getAttribute('src')).toBe(originalUrl);
    expect(button('重试原请求')).toBeUndefined();
    expect(writes()).toHaveLength(2);
  });

  it('结果未知不自动重试，刷新核对后重放同一个命令 ID 和 revision', async () => {
    unknownUpload = true;
    await render();
    await click('模型图设置');
    await selectFile(file());
    await click('保存');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未确认'));
    expect(writes()).toHaveLength(2);
    expect(button('重试原请求')?.disabled).toBe(true);
    await click('刷新');
    await vi.waitFor(() => expect(button('重试原请求')?.disabled).toBe(false));
    await click('重试原请求');
    await vi.waitFor(() => expect(writes()).toHaveLength(3));
    const [first, second] = writes().filter((request) => request.path.endsWith('/upload'));
    expect(second!.headers.get('idempotency-key')).toBe(first!.headers.get('idempotency-key'));
    expect(second!.headers.get('if-match')).toBe(first!.headers.get('if-match'));
    expect(second!.body).toEqual(first!.body);
  });

  it('读取因撤权失败立即清除旧模型图，卸载释放当前图片 URL', async () => {
    current = image();
    await render();
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    const originalUrl = host.querySelector('img')!.getAttribute('src');
    failRead = true;
    await click('刷新');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeNull());
    expect(revokeUrl).toHaveBeenCalledWith(originalUrl);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无权查看人才标准');
    failRead = false;
    await click('刷新');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    const restoredUrl = host.querySelector('img')!.getAttribute('src');
    await act(async () => root.unmount());
    mounted = false;
    expect(revokeUrl).toHaveBeenCalledWith(restoredUrl);
  });
});
