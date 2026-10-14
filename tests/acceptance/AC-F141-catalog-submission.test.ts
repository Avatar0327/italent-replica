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
/** 编辑场景：服务端当前记录（读详情返回它）与收到的 PATCH。 */
let stored: Record<string, unknown> | undefined;
const patches: { ifMatch: string | null; body: Record<string, unknown> }[] = [];
const patchReplies: Response[] = [];
/** 当前页面的目录集合（路径段）与对象可编辑字段（缺省全部）。 */
let collection = 'category-classes';
let editableOverride: string[] | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  posts.length = 0;
  patches.length = 0;
  patchReplies.length = 0;
  stored = undefined;
  collection = 'category-classes';
  editableOverride = undefined;
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
      if (init.method === 'PATCH') {
        patches.push({
          ifMatch: new Headers(init.headers).get('if-match'),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        const queued = patchReplies.shift();
        if (queued) return queued;
        // 与真实后端一致：PATCH 只改请求里带的字段
        stored = { ...stored, ...patches.at(-1)!.body, revision: Number(stored?.revision ?? 0) + 1 };
        return json(stored);
      }
      if (stored && new RegExp(`/${collection}/c1$`).test(url)) return json(stored);
      if (stored && new RegExp(`/${collection}\\?`).test(url) && url.includes('pageSize=15'))
        return json({ items: [stored], page: 1, pageSize: 15, hasDataPermission: true });
      if (url.endsWith('/me/snapshot'))
        return json({ session: { tenantId: 't', userId: 'u' }, apps: [], scope: [], adminMenus: [] });
      if (url.includes('/permission/me/objects/')) {
        const objectCode = url.split('/').at(-1)!;
        const fields = ['name', 'code', 'parentId', 'displayOrder', 'enabled', 'publicDown', 'classId', 'layerId'];
        return json({
          objectCode,
          dataOperations: { create: true, update: true, delete: false },
          viewableFields: fields,
          editableFields: editableOverride ?? fields,
          buttons: [
            { buttonCode: 'create', level: 'list' },
            { buttonCode: 'update', level: 'detail' },
          ],
        });
      }
      if (/\/layers\?/.test(url)) return json({ items: [{ id: 'L2', name: '层级二' }] });
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

async function openPage(view = collection) {
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: [`/qualification?view=${view}`] },
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

it('AC-F141 编辑遇 409：重读确认后改回原值也要重提（按最新记录比较、If-Match 为新版本），差异表原值是打开时读到的记录', async () => {
  stored = { id: 'c1', revision: 1, name: 'A', code: 'K1', enabled: true };
  patchReplies.push(json({ error: { code: 'REVISION_CONFLICT', message: '版本已变化' } }, 409));
  await openPage();
  await vi.waitFor(() => expect(buttonOf('编辑')).toBeDefined());
  await click(buttonOf('编辑'));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-drawer input[type="text"]')).not.toBeNull());
  const nameInput = () => document.body.querySelector<HTMLInputElement>('.ant-drawer input[type="text"]')!;
  expect(nameInput().value).toBe('A');

  await type(nameInput(), 'B');
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ ifMatch: '1', body: { name: 'B' } });

  // 另一位管理员已把名称改成 C（版本 2）
  stored = { ...stored, revision: 2, name: 'C' };
  await vi.waitFor(() => expect(buttonOf('重读最新版本')).toBeDefined());
  await click(buttonOf('重读最新版本'));
  await vi.waitFor(() => expect(buttonOf('已核对差异，继续编辑')).toBeDefined());
  const row = Array.from(document.body.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes('"C"'));
  expect(row?.textContent).toContain('"A"');
  expect(row?.textContent).toContain('"C"');
  expect(row?.textContent).toContain('"B"');

  await click(buttonOf('已核对差异，继续编辑'));
  await type(nameInput(), 'A');
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toMatchObject({ ifMatch: '2', body: { name: 'A' } });
});

it('AC-F141 冲突重读不覆盖没编辑的字段：他人改了编码，重读后编码回填最新值，PATCH 只带本人改过的名称', async () => {
  stored = { id: 'c1', revision: 1, name: 'A', code: 'K1', enabled: true };
  patchReplies.push(json({ error: { code: 'REVISION_CONFLICT', message: '版本已变化' } }, 409));
  await openPage();
  await vi.waitFor(() => expect(buttonOf('编辑')).toBeDefined());
  await click(buttonOf('编辑'));
  await vi.waitFor(() => expect(document.body.querySelector('.ant-drawer input[type="text"]')).not.toBeNull());
  const inputs = () => Array.from(document.body.querySelectorAll<HTMLInputElement>('.ant-drawer input[type="text"]'));
  expect([inputs()[0]!.value, inputs()[1]!.value]).toEqual(['A', 'K1']);

  // 本人只改名称；另一位管理员同时把编码改成 K2（版本 2）
  await type(inputs()[0]!, 'B');
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ ifMatch: '1', body: { name: 'B' } });
  stored = { ...stored, revision: 2, code: 'K2' };

  await vi.waitFor(() => expect(buttonOf('重读最新版本')).toBeDefined());
  await click(buttonOf('重读最新版本'));
  await vi.waitFor(() => expect(buttonOf('已核对差异，继续编辑')).toBeDefined());
  // 差异表按三列展示：编码 原值 K1、最新 K2（本人没改，我的输入 = 原值）
  const codeRow = Array.from(document.body.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes('"K2"'));
  expect(codeRow?.textContent).toContain('"K1"');
  await click(buttonOf('已核对差异，继续编辑'));
  // 没改过的字段回填最新值，改过的保留草稿
  await vi.waitFor(() => expect(inputs()[1]!.value).toBe('K2'));
  expect(inputs()[0]!.value).toBe('B');

  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({ ifMatch: '2', body: { name: 'B' } });
  expect(stored).toMatchObject({ name: 'B', code: 'K2' });
});

const inputsOf = () => Array.from(document.body.querySelectorAll<HTMLInputElement>('.ant-drawer input[type="text"]'));
const openEdit = async () => {
  await vi.waitFor(() => expect(buttonOf('编辑')).toBeDefined());
  await click(buttonOf('编辑'));
  await vi.waitFor(() => expect(inputsOf().length).toBeGreaterThan(0));
};
const layerItem = () =>
  Array.from(document.body.querySelectorAll('.ant-drawer .ant-form-item')).find(
    (item) => item.querySelector('label')?.textContent === '层级',
  )!;
/** 先选一个层级、再清回空值：草稿里留下 undefined，原记录是 null。 */
async function chooseThenClearLayer() {
  const selector = layerItem().querySelector('.ant-select-selector') as HTMLElement;
  await act(async () => {
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await vi.waitFor(() => expect(document.body.querySelector('.ant-select-item-option')).not.toBeNull());
  await click(document.body.querySelector('.ant-select-item-option')!);
  await vi.waitFor(() => expect(layerShown()).toBe('层级二'));
  const clear = layerItem().querySelector('.ant-select-clear') as HTMLElement;
  await act(async () => {
    clear.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clear.click();
  });
  await vi.waitFor(() => expect(layerShown()).toBe(''));
}
const layerShown = () => layerItem().querySelector('.ant-select-selection-item')?.textContent ?? '';

it('AC-F141 空值统一：层级原本为空，本人只改名称，他人把层级改成 L2，重读后层级回填 L2，PATCH 只带名称', async () => {
  collection = 'levels';
  stored = { id: 'c1', revision: 1, name: 'A', code: 'K1', displayOrder: 1, layerId: null, enabled: true };
  patchReplies.push(json({ error: { code: 'REVISION_CONFLICT', message: '版本已变化' } }, 409));
  await openPage();
  await openEdit();
  await type(inputsOf()[0]!, 'B');
  await chooseThenClearLayer();
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ ifMatch: '1', body: { name: 'B' } });
  expect(Object.keys(patches[0]!.body)).toEqual(['name']);
  stored = { ...stored, revision: 2, layerId: 'L2' };

  await vi.waitFor(() => expect(buttonOf('重读最新版本')).toBeDefined());
  await click(buttonOf('重读最新版本'));
  await vi.waitFor(() => expect(buttonOf('已核对差异，继续编辑')).toBeDefined());
  await click(buttonOf('已核对差异，继续编辑'));
  await vi.waitFor(() => expect(layerShown()).toBe('层级二'));
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({ ifMatch: '2', body: { name: 'B' } });
  expect(stored).toMatchObject({ name: 'B', layerId: 'L2' });
});

it('AC-F141 没有层级编辑权、保留名称编辑权：只改名称，PATCH 只有 name', async () => {
  collection = 'levels';
  editableOverride = ['name', 'code', 'displayOrder', 'enabled', 'publicDown'];
  stored = {
    id: 'c1',
    revision: 1,
    name: 'A',
    code: null,
    displayOrder: null,
    layerId: null,
    enabled: true,
    publicDown: null,
  };
  await openPage();
  await openEdit();
  await type(inputsOf()[0]!, 'B');
  await click(buttonOf('保存'));
  await vi.waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ ifMatch: '1', body: { name: 'B' } });
});
