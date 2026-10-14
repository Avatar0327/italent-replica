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
const ORIGINAL = {
  id: 'original-image',
  filename: 'original.png',
  contentType: 'image/png',
  byteSize: 4,
  sha256: '00'.repeat(32),
  status: 'uploaded',
};
type Phase = 'register' | 'upload' | 'delete';
interface Lane {
  label: string;
  phase: Phase;
  replay: boolean;
}
const LANES: Lane[] = [
  { label: '登记', phase: 'register', replay: false },
  { label: '上传', phase: 'upload', replay: false },
  { label: '删除', phase: 'delete', replay: false },
  { label: '登记重放', phase: 'register', replay: true },
  { label: '上传重放', phase: 'upload', replay: true },
  { label: '删除重放', phase: 'delete', replay: true },
];

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let revision: number;
let lane: Lane;
let refusalStatus: number;
let targetWrites: number;
let reads: number;
let permissionPending: boolean;
let permissionGranted: boolean;
let finishRecheck: ((response: Response) => void) | undefined;
let deniedPreview: string | null;
const createUrl = vi.fn<(blob: Blob) => string>();
const revokeUrl = vi.fn<(url: string) => void>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refused(status = refusalStatus) {
  const code = status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED';
  return json(
    { error: { code, message: status === 400 || status === 415 ? '图片格式不合法' : '当前授权已失效' } },
    status,
  );
}

function isTarget(path: string, method: string) {
  return lane.phase === 'register'
    ? method === 'POST' && path === `${BASE}/attachments`
    : lane.phase === 'upload'
      ? method === 'POST' && path.endsWith('/upload')
      : method === 'DELETE' && path === BASE;
}

/** 权限拒绝后的首次详情重读悬挂，证明清图及禁写先于重新核权结果。 */
async function mockFetch(input: string | URL | Request, init: RequestInit = {}) {
  const path = String(input);
  const method = init.method ?? 'GET';
  if (method === 'GET' && path === BASE) {
    reads += 1;
    if (permissionPending)
      return new Promise<Response>((done) => {
        finishRecheck = done;
      });
    return permissionGranted ? json({ revision, canEdit: true, modelImage: ORIGINAL }) : refused(403);
  }
  if (method === 'GET' && path.endsWith('/content'))
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  if (isTarget(path, method)) {
    targetWrites += 1;
    if (lane.replay && targetWrites === 1) throw new TypeError('network disconnected');
    deniedPreview = host.querySelector('img')?.getAttribute('src') ?? null;
    if (refusalStatus === 403 || refusalStatus === 404) permissionPending = true;
    return refused();
  }
  if (method === 'POST' && path === `${BASE}/attachments`) {
    revision += 1;
    return json({ revision, attachment: { ...ORIGINAL, id: 'registered-image', status: 'registered' } }, 201);
  }
  throw new Error(`未登记的 UI 请求：${method} ${path}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  revision = 1;
  lane = LANES[0]!;
  refusalStatus = 403;
  targetWrites = 0;
  reads = 0;
  permissionPending = false;
  permissionGranted = true;
  finishRecheck = undefined;
  deniedPreview = null;
  createUrl.mockReset().mockImplementation(() => `blob:authorized-image-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('fetch', vi.fn(mockFetch));
  vi.stubGlobal('crypto', {
    randomUUID: () => `command-${targetWrites}-${Math.random()}`,
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    finishRecheck?.(refused(403));
  });
  host.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  return Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
}

async function click(label: string) {
  const control = button(label);
  expect(control, label).toBeTruthy();
  expect(control!.disabled, label).toBe(false);
  await act(async () => control!.click());
}

async function render() {
  const { PotentialModelImage } = await import(componentPath);
  await act(async () =>
    root.render(createElement(PotentialModelImage, { tenantId: 'tenant', criterionId: 'criterion' })),
  );
  await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
}

async function replace() {
  await click('替换模型图');
  const value = new File([new Uint8Array(4)], 'replacement.png', { type: 'image/png' });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => new Uint8Array(4).buffer });
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [value] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await click('保存');
}

async function send() {
  if (lane.phase === 'delete') await click('删除模型图');
  else await replace();
  if (lane.replay) {
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未确认'));
    await click('刷新');
    await vi.waitFor(() => expect(button('重试原请求')?.disabled).toBe(false));
    await click('重试原请求');
  }
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前授权已失效'));
}

function expectNoUsableWrites() {
  for (const label of ['模型图设置', '替换模型图', '删除模型图', '保存', '重试原请求']) {
    const control = button(label);
    expect(control === undefined || control.disabled, `${label} 必须禁用或移除`).toBe(true);
  }
}

describe('AC-TC-MODEL-REVOKE-UI 权限拒绝立即清除潜力模型图', () => {
  it.each(LANES.flatMap((item) => [403, 404].map((status) => ({ ...item, status }))))(
    '$label 返回 $status：核权尚未完成时旧图已撤销，重新授权后才恢复',
    async ({ status, ...selected }) => {
      lane = selected;
      refusalStatus = status;
      await render();
      const originalUrl = host.querySelector('img')!.getAttribute('src');
      await send();
      expect(host.querySelector('img')).toBeNull();
      expect(deniedPreview).toBeTruthy();
      expect(revokeUrl).toHaveBeenCalledWith(deniedPreview);
      expectNoUsableWrites();
      expect(finishRecheck, '收到权限拒绝后必须立即重新核权').toBeDefined();
      expect(reads).toBe(lane.replay ? 3 : 2);
      const issued = targetWrites;
      permissionPending = false;
      permissionGranted = false;
      await act(async () => finishRecheck!(refused(403)));
      expect(host.querySelector('img')).toBeNull();
      expectNoUsableWrites();
      expect(targetWrites).toBe(issued);
      permissionGranted = true;
      await click('刷新');
      await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
      expect(host.querySelector('img')!.getAttribute('src')).not.toBe(originalUrl);
      expect(button('替换模型图')?.disabled).toBe(false);
      expect(button('删除模型图')?.disabled).toBe(false);
      expect(targetWrites).toBe(issued);
    },
  );

  it.each([LANES[0]!, LANES[1]!].flatMap((item) => [400, 415].map((status) => ({ ...item, status }))))(
    '$label 返回普通格式错误 $status：保留原图且不触发撤权重读',
    async ({ status, ...selected }) => {
      lane = selected;
      refusalStatus = status;
      await render();
      const originalUrl = host.querySelector('img')!.getAttribute('src');
      await replace();
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('图片格式不合法'));
      expect(host.querySelector('img')!.getAttribute('src')).toBe(originalUrl);
      expect(revokeUrl).not.toHaveBeenCalledWith(originalUrl);
      expect(reads).toBe(1);
      expect(finishRecheck).toBeUndefined();
      expect(button('替换模型图')?.disabled).toBe(false);
      expect(button('删除模型图')?.disabled).toBe(false);
    },
  );
});
