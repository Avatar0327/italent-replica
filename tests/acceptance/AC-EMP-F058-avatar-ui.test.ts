/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const settingsPath = resolve('apps/web/src/account/AvatarSettings.tsx');
const avatarPath = resolve('apps/web/src/shared/PersonAvatar.tsx');
const BASE = '/api/tenant/account/avatar';
const AVATAR_ID = 'f0580000-0000-4000-8000-000000000001';
const CONTENT = `/api/tenant/avatars/${AVATAR_ID}/content`;

interface AvatarReference {
  id: string;
  url: string;
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
let current: AvatarReference | null;
let requests: RecordedRequest[];
let uploadUnknown: boolean;
let conflict: boolean;
let contentDenied: boolean;
let readDenied: boolean;
const createUrl = vi.fn<(blob: Blob) => string>();
const revokeUrl = vi.fn<(url: string) => void>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function view() {
  return { revision, name: '合成员工', avatar: current };
}

async function mockFetch(input: string | URL | Request, init: RequestInit = {}) {
  const path = String(input);
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  requests.push({ path, method, headers, body });
  if (method === 'GET' && path === BASE)
    return readDenied ? json({ error: { code: 'FORBIDDEN', message: '当前账号不可用' } }, 403) : json(view());
  if (method === 'GET' && path.endsWith('/content')) {
    if (contentDenied) return json({ error: { code: 'NOT_FOUND', message: '头像不存在' } }, 404);
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  }
  if (conflict) return json({ error: { code: 'REVISION_CONFLICT', message: '头像已变更' } }, 409);
  if (method === 'POST' && path === `${BASE}/attachments`) {
    revision = 11;
    return json({ revision, attachment: { ...body, id: AVATAR_ID, status: 'registered' } }, 201);
  }
  if (method === 'POST' && path === `${BASE}/attachments/${AVATAR_ID}/upload`) {
    revision = 29;
    current = { id: AVATAR_ID, url: CONTENT };
    if (uploadUnknown) {
      uploadUnknown = false;
      throw new TypeError('network disconnected');
    }
    return json(view());
  }
  if (method === 'DELETE' && path === BASE) {
    revision = 70;
    current = null;
    return json(view());
  }
  throw new Error(`未登记的头像 UI 请求：${method} ${path}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  revision = 4;
  current = null;
  requests = [];
  uploadUnknown = false;
  conflict = false;
  contentDenied = false;
  readDenied = false;
  createUrl.mockReset().mockImplementation(() => `blob:avatar-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('fetch', vi.fn(mockFetch));
  vi.stubGlobal('crypto', {
    randomUUID: () => `avatar-command-${requests.length}-${Math.random()}`,
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function renderSettings(tenantId = 'tenant') {
  const { AvatarSettings } = await import(settingsPath);
  await act(async () => root.render(createElement(AvatarSettings, { tenantId })));
  await vi.waitFor(() => expect(host.textContent).toContain('合成员工'));
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeTruthy();
  await act(async () => target!.click());
}

function file(size = 4, name = 'avatar.png', type = 'image/png') {
  const value = new File([new Uint8Array(size)], name, { type });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => new Uint8Array(size).buffer });
  return value;
}

async function selectFile(value: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).toBeTruthy();
  Object.defineProperty(input, 'files', { value: [value], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

function writes() {
  return requests.filter((request) => request.method !== 'GET');
}

describe('AC-EMP-F058：本人个人设置头像及通用人员头像', () => {
  it('无头像显示彩色圆底姓名缩写，拉取失败仍回退姓名缩写', async () => {
    const { PersonAvatar } = await import(avatarPath);
    await act(async () =>
      root.render(createElement(PersonAvatar, { tenantId: 'tenant', name: '合成员工', avatar: null })),
    );
    const fallback = host.querySelector<HTMLElement>('[role="img"]')!;
    expect(fallback.textContent).toBe('员工');
    expect(fallback.style.backgroundColor).not.toBe('');
    expect(fallback.style.borderRadius).toBe('50%');
    expect(requests).toHaveLength(0);
    contentDenied = true;
    await act(async () =>
      root.render(
        createElement(PersonAvatar, { tenantId: 'tenant', name: 'Jane Doe', avatar: { id: AVATAR_ID, url: CONTENT } }),
      ),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="img"]')?.textContent).toBe('JD');
  });

  it('头像以当前租户认证请求读取 blob，组件卸载释放图片 URL', async () => {
    const { PersonAvatar } = await import(avatarPath);
    await act(async () =>
      root.render(
        createElement(PersonAvatar, { tenantId: 'tenant', name: '合成员工', avatar: { id: AVATAR_ID, url: CONTENT } }),
      ),
    );
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(requests[0]!.headers.get('x-tenant-id')).toBe('tenant');
    expect(host.querySelector('img')!.getAttribute('src')).toBe('blob:avatar-1');
    await act(async () => root.unmount());
    mounted = false;
    expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-1');
  });

  it('头像引用须为匹配的 UUID 内容路径，规范大小写后读取且不请求任意地址', async () => {
    const { PersonAvatar } = await import(avatarPath);
    await act(async () =>
      root.render(
        createElement(PersonAvatar, {
          tenantId: 'tenant',
          name: '合成员工',
          avatar: { id: AVATAR_ID.toUpperCase(), url: `/api/tenant/avatars/${AVATAR_ID.toUpperCase()}/content` },
        }),
      ),
    );
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(requests[0]!.path).toBe(CONTENT);
    await act(async () =>
      root.render(
        createElement(PersonAvatar, {
          tenantId: 'tenant',
          name: '合成员工',
          avatar: { id: AVATAR_ID, url: 'https://example.com/avatar.png' },
        }),
      ),
    );
    expect(host.querySelector('img')).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-1');
    expect(requests).toHaveLength(1);
    await act(async () =>
      root.render(
        createElement(PersonAvatar, {
          tenantId: 'tenant',
          name: '合成员工',
          avatar: { id: 'invalid', url: '/api/tenant/avatars/invalid/content' },
        }),
      ),
    );
    expect(requests).toHaveLength(1);
  });

  it('已有图片在切换租户的同次渲染消失，释放旧租户 blob URL', async () => {
    const { PersonAvatar } = await import(avatarPath);
    await act(async () =>
      root.render(
        createElement(PersonAvatar, { tenantId: 'old', name: '旧租户员工', avatar: { id: AVATAR_ID, url: CONTENT } }),
      ),
    );
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    await act(async () =>
      root.render(createElement(PersonAvatar, { tenantId: 'new', name: '新租户员工', avatar: null })),
    );
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('新租户员工的头像');
    expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-1');
  });

  it('本人上传、替换、删除只写账号头像，后续命令使用服务端返回的 revision', async () => {
    await renderSettings();
    await selectFile(file());
    await click('保存头像');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(writes()).toHaveLength(2);
    expect(writes()[0]!.headers.get('if-match')).toBe('4');
    expect(writes()[1]!.headers.get('if-match')).toBe('11');
    expect(writes()[0]!.body).toMatchObject({ filename: 'avatar.png', contentType: 'image/png', byteSize: 4 });
    expect(writes()[0]!.body?.sha256).toBe('00'.repeat(32));
    expect(writes()[1]!.body).toEqual({ base64: 'AAAAAA==' });
    for (const request of writes()) expect(request.headers.get('idempotency-key')).toBeTruthy();
    await selectFile(file(4, 'replacement.png'));
    await click('保存头像');
    await vi.waitFor(() => expect(writes()).toHaveLength(4));
    expect(writes()[2]!.headers.get('if-match')).toBe('29');
    await click('删除头像');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeNull());
    expect(writes().at(-1)!.headers.get('if-match')).toBe('29');
    expect(writes().at(-1)!.path).toBe(BASE);
    expect(host.querySelector('[role="img"]')?.textContent).toBe('员工');
    expect(writes().every((request) => request.path.startsWith(BASE))).toBe(true);
  });

  it('超过 5MB 或伪扩展名格式在上传前拒绝且不创建命令', async () => {
    await renderSettings();
    await selectFile(file(5 * 1024 * 1024 + 1));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('5MB');
    expect(button('保存头像')!.disabled).toBe(true);
    await selectFile(file(4, 'fake.png', 'image/svg+xml'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('格式');
    expect(writes()).toHaveLength(0);
  });

  it('上传结果未知不自动重放，先显式刷新确认服务端当前头像', async () => {
    uploadUnknown = true;
    await renderSettings();
    await selectFile(file());
    await click('保存头像');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未确认'));
    expect(writes()).toHaveLength(2);
    expect(button('保存头像')!.disabled).toBe(true);
    await click('刷新');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(requests.filter((request) => request.method === 'GET' && request.path === BASE)).toHaveLength(2);
    expect(writes()).toHaveLength(2);
    expect(button('删除头像')!.disabled).toBe(false);
  });

  it('结果未知后的回查失败持续冻结写入，再次回查成功才允许显式提交', async () => {
    uploadUnknown = true;
    await renderSettings();
    await selectFile(file());
    await click('保存头像');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未确认'));
    readDenied = true;
    await click('刷新');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前账号不可用');
    expect(button('保存头像')!.disabled).toBe(true);
    expect(host.querySelector('img')).toBeNull();
    expect(writes()).toHaveLength(2);
    readDenied = false;
    await click('刷新');
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(button('删除头像')!.disabled).toBe(false);
    expect(writes()).toHaveLength(2);
  });

  it('409 要求显式刷新后重新提交，不能自动修改 revision 重试', async () => {
    conflict = true;
    await renderSettings();
    await selectFile(file());
    await click('保存头像');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('刷新'));
    expect(writes()).toHaveLength(1);
    expect(button('保存头像')!.disabled).toBe(true);
    conflict = false;
    revision = 8;
    await click('刷新');
    await selectFile(file());
    await click('保存头像');
    await vi.waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[1]!.headers.get('if-match')).toBe('8');
    expect(writes()[1]!.headers.get('idempotency-key')).not.toBe(writes()[0]!.headers.get('idempotency-key'));
  });

  it('切换租户立即清旧头像，旧租户迟到读取不下载也不填入新租户', async () => {
    let finishOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get('x-tenant-id') === 'old-tenant')
        return new Promise<Response>((resolveOld) => {
          finishOld = resolveOld;
        });
      return mockFetch(input, init);
    });
    const { AvatarSettings } = await import(settingsPath);
    await act(async () => root.render(createElement(AvatarSettings, { tenantId: 'old-tenant' })));
    await renderSettings('new-tenant');
    await act(async () =>
      finishOld(json({ revision: 2, name: '旧租户员工', avatar: { id: AVATAR_ID, url: CONTENT } })),
    );
    expect(host.textContent).not.toContain('旧租户员工');
    expect(host.querySelector('img')).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    expect(requests.some((request) => request.path.endsWith('/content'))).toBe(false);
  });

  it('员工自助档案显示只读账号头像，并提供个人设置入口', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/self-service/profile'))
        return json({
          timezone: 'Asia/Shanghai',
          today: '2026-10-09',
          employee: {
            id: 'synthetic-employee',
            name: '合成员工',
            code: 'SYNTHETIC',
            revision: 1,
            avatar: { id: AVATAR_ID, url: CONTENT },
          },
          record: null,
        });
      return mockFetch(input, init);
    });
    const { EmployeePage } = await import(resolve('apps/web/src/employee-self-service/EmployeePage.tsx'));
    await act(async () => root.render(createElement(EmployeePage)));
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'tenant');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(host.textContent).toContain('合成员工'));
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy());
    expect(host.querySelector('a[href="/account"]')?.textContent).toBe('个人设置');
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
