/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-141 第 2 轮 P2（DEC-500）：任职分类维护页（目录页表单）接入 F-123 表单提交内核。
 * 未知结果（断网 / 超时）后，未确认的命令保存在页面级 FormCommands 里：关闭重开、切换页签后都不会用新的命令 ID 再发一次，
 * 重开的表单只读锁定“处理中 / 结果待确认”。服务器明确拒绝时保留输入、允许改正后重提。
 * 整页挂载 CatalogModule（真实菜单、权限、表单、内核），只替换 fetch。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { CatalogModule } = await import(resolve('apps/web/src/talent/catalog/CatalogModule.tsx'));
const { qualificationResources } = await import(resolve('apps/web/src/qualification/resources.ts'));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const posts: { key: string | null; body: string }[] = [];
let postMode: 'network-error' | 'rejected' = 'network-error';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  posts.length = 0;
  postMode = 'network-error';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const url = String(path);
      if (init.method === 'POST') {
        posts.push({ key: new Headers(init.headers).get('idempotency-key'), body: String(init.body) });
        if (postMode === 'network-error') throw new TypeError('断网');
        return json({ error: { code: 'VALIDATION_FAILED', message: '分类编码已存在' } }, 422);
      }
      if (url.endsWith('/me/snapshot'))
        return json({ session: { tenantId: 't', userId: 'u' }, apps: [], scope: [], adminMenus: [] });
      if (url.includes('/permission/me/objects/')) {
        const objectCode = url.split('/').at(-1)!;
        const fields = ['name', 'code', 'parentId', 'displayOrder', 'enabled', 'publicDown', 'classId', 'layerId'];
        return json({
          objectCode,
          dataOperations: { create: true, update: true, delete: false },
          viewableFields: fields,
          editableFields: fields,
          buttons: [
            { buttonCode: 'create', level: 'list' },
            { buttonCode: 'update', level: 'detail' },
          ],
        });
      }
      if (url.includes('/candidates/owner-orgs')) return json({ items: [{ id: 'org-1', name: '管理单元甲' }] });
      return json({ items: [], page: 1, pageSize: 15, hasDataPermission: true });
    }),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? '';
const buttonOf = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.replace(/\s/g, '') === label);
const click = (element: Element | undefined) => act(async () => (element as HTMLElement).click());
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const menu = (label: string) => Array.from(document.body.querySelectorAll('li')).find((li) => li.textContent === label);

async function openPage() {
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/qualification?view=category-classes'] },
        h(
          SessionProvider,
          { session: { tenantId: 't', identityKey: 'u' } },
          h(PermissionsProvider, {}, h(CatalogModule, { resources: qualificationResources })),
        ),
      ),
    );
  });
  await vi.waitFor(() => expect(buttonOf('新建')).toBeDefined());
}
async function openCreate() {
  await click(buttonOf('新建'));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-drawer input, .ant-modal input')).not.toBeNull());
}
async function fillAndSave(name = '分类甲', code = 'CLASS_A') {
  const inputs = Array.from(
    document.body.querySelectorAll<HTMLInputElement>('.ant-drawer input[type="text"], .ant-modal input[type="text"]'),
  );
  await type(inputs[0]!, name);
  await type(inputs[1]!, code);
  await click(buttonOf('保存'));
}
const closeForm = async () => {
  await click(buttonOf('取消'));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-drawer-content')).toBeNull());
};

it('AC-F141 未知结果后关闭重开：不发第二个命令，表单锁定显示“处理中 / 结果待确认”', async () => {
  await openPage();
  await openCreate();
  await fillAndSave();
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-alert')).not.toBeNull());
  const first = posts[0]!;

  await closeForm();
  await openCreate();
  await fillAndSave();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual(first);
  expect(text()).toContain('结果待确认');
  expect(buttonOf('保存')?.hasAttribute('disabled')).toBe(true);
});

it('AC-F141 未知结果后切换页签再回来：仍不发第二个命令，幂等键不变', async () => {
  await openPage();
  await openCreate();
  await fillAndSave();
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-alert')).not.toBeNull());
  const first = posts[0]!;
  await closeForm();

  await click(menu('任职类别'));
  await vi.waitFor(() => expect(text()).toContain('任职类别'));
  await click(menu('任职分类'));
  await vi.waitFor(() => expect(buttonOf('新建')).toBeDefined());
  await openCreate();
  await fillAndSave();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.key).toBe(first.key);
  expect(buttonOf('保存')?.hasAttribute('disabled')).toBe(true);
});

it('AC-F141 服务器明确拒绝：保留输入并显示原因，改正后可以重提（新命令）', async () => {
  postMode = 'rejected';
  await openPage();
  await openCreate();
  await fillAndSave('分类乙', 'CLASS_B');
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  await vi.waitFor(() => expect(text()).toContain('分类编码已存在'));
  const inputs = Array.from(document.body.querySelectorAll<HTMLInputElement>('.ant-drawer input[type="text"]'));
  expect(inputs[0]!.value).toBe('分类乙');
  expect(buttonOf('保存')?.hasAttribute('disabled')).toBe(false);
  await type(inputs[1]!, 'CLASS_C');
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]!.key).not.toBe(posts[0]!.key);
});
