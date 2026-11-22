/// <reference lib="dom" />
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { ControlledGrants } from './AC-LNK-support.js';
import type { offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';

// 保留 Node 网络全局，PGlite 与真实 Hono 请求沿用原生 URL / Response。
const dom = new Window({ url: 'http://localhost' });
for (const key of Object.getOwnPropertyNames(dom)) {
  if (key in globalThis) continue;
  const value = (dom as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom) : value,
  });
}
Object.assign(globalThis, { window: dom, document: dom.document, Event: dom.Event });

const requireWeb = createRequire(resolve('apps/web/package.json'));
export const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { App, ConfigProvider } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
export const { OfferList } = await import(resolve('apps/web/src/offers/OfferList.tsx'));

type World = Awaited<ReturnType<typeof offerSigningWorld>>;
type Request = {
  method: string;
  path: string;
  key?: string;
  revision?: number;
  body?: Record<string, unknown>;
};
type Intercept = (request: Request, forward: () => Promise<Response>) => Promise<Response>;
type Options = {
  grants?: ControlledGrants;
  update?: boolean;
  records?: boolean;
  allowDownload?: boolean;
  intercept?: Intercept;
};
const offerObject = 'TenantBase.Offer';
const recordsObject = 'TenantBase.ESignRecord';
const settingsObject = 'TenantBase.ESignSettings';
const offerFields = ['id', 'name', 'personalEmail'];
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** 只固定外壳权限快照；工作流请求与用户操作实际进入 S4/S2 路由。 */
export async function mount(w: World, options: Options = {}, component = OfferList) {
  const { grants, update = true, records = true, allowDownload = false, intercept } = options;
  const session = {
    tenantId: w.tenantId,
    userId: w.userId,
    identityKey: w.userId,
    timezone: 'Asia/Shanghai',
    displayName: 'ZZ_F505_HR',
    tenantName: 'ZZ_F505_租户',
    source: 'server',
  };
  const call = w.access({
    ...grants,
    deny: (q) =>
      (!update && q.resource === offerObject && q.action === 'object.update') ||
      (!records && q.resource === recordsObject && q.action === 'object.view') ||
      !!grants?.deny?.(q),
    fields: { [offerObject]: offerFields, ...grants?.fields },
  });
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/permission/me/snapshot'))
      return Response.json({ session, apps: [], scope: [], adminMenus: [] });
    if (url.pathname.includes('/permission/me/objects/')) {
      const objectCode = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (objectCode === recordsObject && !records)
        return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
      const isSettings = objectCode === settingsObject;
      const fields = isSettings
        ? ['validityDays', 'remindBeforeExpiry']
        : objectCode === recordsObject
          ? ['status', 'files', 'scene', 'initiatedAt']
          : offerFields;
      return Response.json({
        objectCode,
        dataOperations: { update: isSettings || update },
        viewableFields: fields,
        editableFields: fields,
        buttons:
          objectCode === recordsObject && allowDownload ? [{ buttonCode: 'ESignRecord.Download', level: 'list' }] : [],
      });
    }
    const headers = new Headers(init?.headers);
    const request = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      key: headers.get('idempotency-key') ?? undefined,
      revision: headers.has('if-match') ? Number(headers.get('if-match')) : undefined,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const forward = () =>
      call(request.method, request.path, { key: request.key, ifMatch: request.revision, body: request.body });
    return intercept ? intercept(request, forward) : forward();
  });
  await act(async () => {
    root.render(
      h(
        SessionProvider,
        { session },
        h(PermissionsProvider, null, h(ConfigProvider, null, h(App, null, h(component)))),
      ),
    );
  });
  return requests;
}

export const text = (target: Element | null = document.body) => (target?.textContent ?? '').replace(/\s+/g, '');
export const control = (label: string, target: ParentNode = document) =>
  Array.from(target.querySelectorAll<HTMLElement>('button,[role="menuitem"]')).find(
    (node) => text(node) === label.replace(/\s+/g, '') || node.getAttribute('aria-label') === label,
  );
export const dialog = () => document.querySelector<HTMLElement>('.ant-modal');
export const row = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('tr[data-row-key]')).find((node) => text(node).includes(name));
export async function until(check: () => unknown, description: string) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(check(), description).toBeTruthy();
    },
    { timeout: 6500, interval: 25 },
  );
}
export async function click(node: HTMLElement | undefined | null) {
  expect(node, '操作控件存在').toBeTruthy();
  await act(async () => node!.click());
}
export async function openMenu(name: string, view = '已接受Offer') {
  if (!row(name)) await click(control(view));
  await until(() => row(name), `列表显示 ${name}`);
  await click(control('行操作', row(name)!) ?? row(name)!.querySelector('button[aria-label]'));
  await until(() => document.querySelector('[role="menuitem"]'), '行菜单已展开');
}
export async function openSign(name: string, view?: string) {
  await openMenu(name, view);
  const item = control('发起电子签署');
  expect(item?.getAttribute('aria-disabled'), '服务端返回的发起动作可用').not.toBe('true');
  await click(item);
  await until(dialog, '打开电子签署弹窗');
}
export async function selectAll() {
  await until(() => dialog()?.querySelector('select option'), '模板选项已加载');
  await click(dialog()?.querySelector<HTMLInputElement>('input[name="esignTemplateAll"]'));
}
export const confirm = () => control('确定', dialog() ?? document) as HTMLButtonElement | undefined;
