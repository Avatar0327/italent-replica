/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-TRF-F481-FE-05（F-481 设计 §8.2 菜单、§8.4、§12）：电子签菜单组与两张设置页。
 * 菜单从各模块登记汇总里找（用户能否看到入口），页面从登记的入口取（与路由挂载同一个组件）。
 * 模板新建 / 编辑 / 启停按后端契约（esign/routes.ts、input.ts）：新建 POST 全量，编辑 PATCH 只发改动字段、带 If-Match；
 * 场景设置有效期只接受 2～30；签署流程、确认方式、消息设置只读，注明“复刻固定，不可配置”。
 * 授权夹具按后端真实出参：电子签设置是配置类对象，/me/objects 走 permission/me.ts configObjectPermission
 * （全部字段可看、非系统字段可改、不可删除、按钮恒为空）；没有“其他设置”权限时对象与接口都是 403。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ESIGN_NOTICE_TEMPLATES, MODULE_OBJECTS } from '@italent/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Suspense } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App, ConfigProvider } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { PAGES } = await import(resolve('apps/web/src/foundation/routes.ts'));
const { menuNodes } = await import(resolve('apps/web/src/foundation/permission-snapshot.ts'));

const SETTINGS_OBJECT = 'TenantBase.ESignSettings';
const BASE = '/api/tenant/esign';
const TEMPLATES = `${BASE}/templates`;
const SCENE = `${BASE}/scenes/transfer`;
const T1 = '84810000-0000-4000-8000-000000000501';
const T2 = '84810000-0000-4000-8000-000000000502';
const session = {
  tenantId: '10000000-0000-4000-8000-000000000485',
  userId: '20000000-0000-4000-8000-000000000485',
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
const template = (id: string, extra: Record<string, unknown>) => ({
  id,
  code: 'SYN-TRF',
  name: '合成调动协议',
  body: '{员工姓名}自{调动生效日期}起调入{调入部门}。',
  status: 'enabled',
  sortOrder: 10,
  revision: 3,
  ...extra,
});

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
  readonly ifMatch: string | null;
}
const definition = MODULE_OBJECTS.eSignSettings;
// 同 me.ts configObjectPermission：对象定义里登记的 create@list 等按钮不下发，配置对象只有“能进 / 不能进”两档。
const configPermission = () => ({
  objectCode: definition.code,
  dataOperations: { create: true, update: true, delete: false },
  viewableFields: definition.fields.map((field) => field.code).sort(),
  editableFields: definition.fields
    .filter((field) => !field.system)
    .map((field) => field.code)
    .sort(),
  buttons: [],
});
const FORBIDDEN: Reply = { status: 403, body: { error: { code: 'FORBIDDEN', message: '无权访问该对象' } } };
let configAllowed: boolean;
let rows: unknown[];
let scene: Reply;
let writes: Reply[];
let sent: Sent[];
function replyOf(url: URL, init: RequestInit): Reply {
  const path = url.pathname;
  const method = init.method ?? 'GET';
  if (path.endsWith('/me/snapshot')) return { body: { session, apps: [], scope: [], adminMenus: [] } };
  if (path.includes('/permission/me/objects/')) {
    const objectCode = decodeURIComponent(path.split('/').at(-1)!);
    if (objectCode === SETTINGS_OBJECT) return configAllowed ? { body: configPermission() } : FORBIDDEN;
    return { body: { objectCode, dataOperations: {}, viewableFields: [], editableFields: [], buttons: [] } };
  }
  if (!configAllowed && path.startsWith(BASE)) return FORBIDDEN;
  if (method !== 'GET' && path.startsWith(BASE)) {
    const headers = new Headers(init.headers);
    sent.push({
      method,
      path,
      body: JSON.parse(String(init.body)),
      key: headers.get('idempotency-key'),
      ifMatch: headers.get('if-match'),
    });
    return writes.shift() ?? { status: 500, body: {} };
  }
  if (path === TEMPLATES) return { body: { items: rows } };
  if (path === SCENE) return scene;
  return { body: { items: [] } };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  configAllowed = true;
  rows = [template(T1, {}), template(T2, { code: 'SYN-NDA', name: '合成保密协议', status: 'disabled', revision: 1 })];
  scene = { body: { scene: 'transfer', validityDays: 2, remindBeforeExpiry: false, revision: 4 } };
  writes = [];
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const reply = replyOf(new URL(String(raw), 'http://localhost'), init);
      return Response.json(reply.body, { status: reply.status ?? 200 });
    }),
  );
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

type Entry = { id: string; label: string; children?: Entry[]; page?: { Component: unknown } };
const group = () => (PAGES.entries as Entry[]).find((entry) => entry.label === '电子签');
const child = (label: string) => group()?.children?.find((item) => item.label === label);
const settle = (ms = 30) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function open(label: string) {
  const page = child(label)?.page;
  expect(page, `电子签 > ${label} 有页面`).toBeTruthy();
  const theme = { token: { motion: false } };
  const node = h(Suspense, { fallback: null }, h(page!.Component as never));
  await act(async () =>
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/'] },
        h(SessionProvider, { session }, h(PermissionsProvider, {}, h(ConfigProvider, { theme }, h(App, {}, node)))),
      ),
    ),
  );
  await settle(80);
}
const pressable = (scope: ParentNode | null | undefined, label: string) =>
  Array.from(scope?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  );
async function click(element: Element | null | undefined) {
  expect(element, '可点击的元素').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}
const drawer = () => document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-content');
const control = (name: string) =>
  drawer()?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${name}"]`) ?? null;
async function type(name: string, value: string) {
  const element = control(name);
  expect(element, `字段 ${name} 可编辑`).toBeTruthy();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
    element!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const save = async () => {
  await click(pressable(document.querySelector('.ant-drawer-open'), '保存'));
  await settle(60);
};
const rowOf = (text: string) =>
  Array.from(host.querySelectorAll('.ant-table-tbody tr')).find((tr) => tr.textContent?.includes(text));

describe('AC-TRF-F481-FE-05 电子签菜单组', () => {
  it('FE-05-01 菜单组「电子签」依次登记 我的签署 / 签署记录 / 签署场景设置 / 设置', () => {
    expect(group()?.children?.map((item) => item.label)).toEqual(['我的签署', '签署记录', '签署场景设置', '设置']);
  });

  it('FE-05-02 只有电子签配置对象授权时：只显示两张设置页，签署记录与我的签署（S5）不出现', () => {
    const snapshot = (entryObjects: string[]) => ({
      apps: [{ app: 'settings', visible: true, entryObjects }],
      adminMenus: [],
    });
    const esign = (entryObjects: string[]) =>
      menuNodes(PAGES.entries, snapshot(entryObjects)).find((node: { label: string }) => node.label === '电子签');
    expect(esign([SETTINGS_OBJECT])?.children?.map((node: { label: string }) => node.label)).toEqual([
      '签署场景设置',
      '设置',
    ]);
    expect(esign([])).toBeUndefined();
  });
});

describe('AC-TRF-F481-FE-05 电子签 > 设置（签署模板）', () => {
  it('FE-05-03 列表显示名称、编码、状态；没有删除入口', async () => {
    await open('设置');
    expect(host.querySelector('h1')?.textContent).toBe('签署模板');
    expect(rowOf('合成调动协议')?.textContent).toContain('SYN-TRF');
    expect(rowOf('合成调动协议')?.textContent).toContain('启用');
    expect(rowOf('合成保密协议')?.textContent).toContain('停用');
    expect(pressable(host, '删除')).toBeUndefined();
  });

  it('FE-05-04 新建：抽屉列出可用变量；保存发 POST 全量（编码 / 名称 / 正文 / 顺序）并带命令 ID', async () => {
    writes = [
      { status: 201, body: template('84810000-0000-4000-8000-000000000503', { code: 'SYN-NEW', revision: 1 }) },
    ];
    await open('设置');
    await click(pressable(host.querySelector('.page-heading'), '新建'));
    expect(drawer()?.textContent).toContain('新建签署模板');
    for (const name of ['{员工姓名}', '{调入部门}', '{新合同结束日期}', '{企业名称}'])
      expect(drawer()?.textContent).toContain(name);
    await type('name', '合成新协议');
    await type('code', 'SYN-NEW');
    await type('body', '{员工姓名}确认调入{调入部门}。');
    await type('sortOrder', '30');
    await save();
    expect(sent).toEqual([
      {
        method: 'POST',
        path: TEMPLATES,
        body: { code: 'SYN-NEW', name: '合成新协议', body: '{员工姓名}确认调入{调入部门}。', sortOrder: 30 },
        key: expect.any(String),
        ifMatch: null,
      },
    ]);
    expect(drawer()).toBeNull();
  });

  it('FE-05-05 正文含未支持的变量：提交前就提示变量名，不发请求', async () => {
    await open('设置');
    await click(pressable(host.querySelector('.page-heading'), '新建'));
    await type('name', '合成新协议');
    await type('code', 'SYN-NEW');
    await type('body', '{员工姓名}的{身份证号}与{手机号}');
    await save();
    expect(drawer()?.textContent).toContain('正文含未支持的变量：身份证号、手机号');
    expect(sent).toEqual([]);
  });

  it('FE-05-06 新建被拒（编码重复）显示后端中文原因，抽屉保留', async () => {
    writes = [{ status: 409, body: { error: { code: 'CONFLICT', message: '模板编码已存在' } } }];
    await open('设置');
    await click(pressable(host.querySelector('.page-heading'), '新建'));
    await type('name', '合成新协议');
    await type('code', 'SYN-TRF');
    await type('body', '正文');
    await save();
    expect(drawer()?.textContent).toContain('模板编码已存在');
  });

  it('FE-05-07 编辑：编码只读；只发改动字段，带 If-Match 本行版本', async () => {
    writes = [{ body: template(T1, { name: '合成调动协议（新）', revision: 4 }) }];
    await open('设置');
    await click(pressable(rowOf('合成调动协议'), '编辑'));
    expect(drawer()?.textContent).toContain('编辑签署模板');
    expect(control('code')).toBeNull();
    expect(drawer()?.textContent).toContain('SYN-TRF');
    await type('name', '合成调动协议（新）');
    await save();
    expect(sent).toEqual([
      {
        method: 'PATCH',
        path: `${TEMPLATES}/${T1}`,
        body: { name: '合成调动协议（新）' },
        key: expect.any(String),
        ifMatch: '3',
      },
    ]);
  });

  it('FE-05-08 停用 / 启用：PATCH status，带本行版本', async () => {
    writes = [
      { body: template(T1, { status: 'disabled', revision: 4 }) },
      { body: template(T2, { code: 'SYN-NDA', name: '合成保密协议', status: 'enabled', revision: 2 }) },
    ];
    await open('设置');
    await click(pressable(rowOf('合成调动协议'), '停用'));
    await click(pressable(rowOf('合成保密协议'), '启用'));
    expect(sent.map(({ method, path, body, ifMatch }) => ({ method, path, body, ifMatch }))).toEqual([
      { method: 'PATCH', path: `${TEMPLATES}/${T1}`, body: { status: 'disabled' }, ifMatch: '3' },
      { method: 'PATCH', path: `${TEMPLATES}/${T2}`, body: { status: 'enabled' }, ifMatch: '1' },
    ]);
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
  });

  it('FE-05-09 没有电子签配置权限（对象与接口都 403）：两页提示无权访问，不显示新建、编辑、停用', async () => {
    configAllowed = false;
    for (const label of ['设置', '签署场景设置']) {
      await open(label);
      expect(host.textContent).toContain('暂无访问权限');
      expect(host.querySelector('.ant-table-tbody tr')).toBeNull();
      for (const action of ['新建', '编辑', '停用', '启用']) expect(pressable(host, action)).toBeUndefined();
    }
  });

  it('FE-05-22 真实配置对象授权（/me/objects 按钮恒为空）：模板新建、编辑、停用 / 启用与场景编辑入口都在', async () => {
    expect(configPermission().buttons).toEqual([]);
    expect(definition.buttons.length, '对象定义虽登记了按钮，配置对象不下发').toBeGreaterThan(0);
    await open('设置');
    expect(pressable(host.querySelector('.page-heading'), '新建')).toBeTruthy();
    expect(pressable(rowOf('合成调动协议'), '编辑')).toBeTruthy();
    expect(pressable(rowOf('合成调动协议'), '停用')).toBeTruthy();
    expect(pressable(rowOf('合成保密协议'), '启用')).toBeTruthy();
    await open('签署场景设置');
    expect(pressable(rowOf('调动电子签署'), '编辑')).toBeTruthy();
  });
});

describe('AC-TRF-F481-FE-05 电子签 > 签署场景设置', () => {
  it('FE-05-10 只有一行“调动电子签署”：所属应用组织员工、描述调动协议电子签署、当前有效期', async () => {
    await open('签署场景设置');
    const lines = host.querySelectorAll('.ant-table-tbody tr');
    expect(lines).toHaveLength(1);
    for (const text of ['调动电子签署', '组织员工', '调动协议电子签署', '2 天'])
      expect(lines[0]!.textContent).toContain(text);
  });

  it('FE-05-11 有效期只接受 2～30：1 与 31 提示且不发请求，上限 30 发 PUT（带到期前提醒与 If-Match）', async () => {
    writes = [{ body: { scene: 'transfer', validityDays: 30, remindBeforeExpiry: false, revision: 5 } }];
    await open('签署场景设置');
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    for (const value of ['1', '31']) {
      await type('validityDays', value);
      await save();
      expect(drawer()?.textContent).toContain('签署有效期须为 2～30 天的整数');
    }
    expect(sent).toEqual([]);
    await type('validityDays', '30');
    await save();
    expect(sent).toEqual([
      {
        method: 'PUT',
        path: SCENE,
        body: { validityDays: 30, remindBeforeExpiry: false },
        key: expect.any(String),
        ifMatch: '4',
      },
    ]);
  });

  it('FE-05-12 签署流程、确认方式、消息设置只读展示固定值，注明“复刻固定，不可配置”', async () => {
    await open('签署场景设置');
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    const text = drawer()?.textContent ?? '';
    for (const fixed of ['签署流程', '员工本人', '企业确认', '确认方式', '消息设置', '复刻固定，不可配置'])
      expect(text).toContain(fixed);
    for (const notice of Object.values(ESIGN_NOTICE_TEMPLATES)) expect(text).toContain(notice.title);
    // 可操作的控件只有两项：有效期输入框 + 到期前自动提醒的“是 / 否”
    const editable = Array.from(drawer()?.querySelectorAll<HTMLInputElement>('input, textarea, select') ?? []).filter(
      (item) => !item.disabled && item.type !== 'hidden',
    );
    expect(editable.map((item) => item.type).sort()).toEqual(['radio', 'radio', 'text']);
    expect(control('validityDays')).toBeTruthy();
  });
});

/**
 * 并发（AGENTS.md §10、自查第 2 条）：409 与结果未知分开处理（F-142 内核）。错误体按后端 esign/service.ts：
 * 陈旧版本 → 409 REVISION_CONFLICT（details.expected 为当前版本）；503 视为结果未知。
 * 结果未知会把命令钉在页面级存储里（模块级 store），所以这一组放在文件最后、结果未知用例排最后。
 */
describe('AC-TRF-F481-FE-05 电子签设置页并发：409 重读与结果未知', () => {
  const overlay = () => document.querySelector('.ant-drawer-open');
  const stale = (message: string, expected: number) => ({
    status: 409,
    body: { error: { code: 'REVISION_CONFLICT', message, details: { expected } } },
  });

  it('FE-05-13 场景保存 409：重读最新版本后重提，带新版本与新命令 ID；没改的到期前提醒取最新值，不被旧值覆盖', async () => {
    writes = [
      stale('签署场景设置已被修改，请刷新后重试', 6),
      { body: { scene: 'transfer', validityDays: 7, remindBeforeExpiry: true, revision: 7 } },
    ];
    await open('签署场景设置');
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    await type('validityDays', '7');
    await save();
    expect(drawer()?.textContent).toContain('版本冲突');
    // 他人同时把“到期前自动提醒”改成了是
    scene = { body: { scene: 'transfer', validityDays: 2, remindBeforeExpiry: true, revision: 6 } };
    await click(pressable(overlay(), '重读最新版本'));
    await click(pressable(overlay(), '已核对差异，继续编辑'));
    await save();
    expect(sent.map(({ method, body, ifMatch }) => ({ method, body, ifMatch }))).toEqual([
      { method: 'PUT', body: { validityDays: 7, remindBeforeExpiry: false }, ifMatch: '4' },
      { method: 'PUT', body: { validityDays: 7, remindBeforeExpiry: true }, ifMatch: '6' },
    ]);
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it('FE-05-14 模板编辑 409：重读后重提只发改过的名称，带最新版本与新命令 ID', async () => {
    writes = [
      stale('签署模板已被修改，请刷新后重试', 5),
      { body: template(T1, { name: '合成调动协议（新）', body: '他人改过的正文', revision: 6 }) },
    ];
    await open('设置');
    await click(pressable(rowOf('合成调动协议'), '编辑'));
    await type('name', '合成调动协议（新）');
    await save();
    expect(drawer()?.textContent).toContain('版本冲突');
    rows = [template(T1, { body: '他人改过的正文', revision: 5 }), rows[1]];
    await click(pressable(overlay(), '重读最新版本'));
    await click(pressable(overlay(), '已核对差异，继续编辑'));
    await save();
    expect(sent.map(({ method, body, ifMatch }) => ({ method, body, ifMatch }))).toEqual([
      { method: 'PATCH', body: { name: '合成调动协议（新）' }, ifMatch: '3' },
      { method: 'PATCH', body: { name: '合成调动协议（新）' }, ifMatch: '5' },
    ]);
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it('FE-05-15 模板编辑 409 后把名称改回打开时的原值：按最新版本发出原值，不当作“没改”吞掉', async () => {
    writes = [stale('签署模板已被修改，请刷新后重试', 5), { body: template(T1, { revision: 6 }) }];
    await open('设置');
    await click(pressable(rowOf('合成调动协议'), '编辑'));
    await type('name', '合成调动协议（新）');
    await save();
    // 他人同时把名称改成了别的值
    rows = [template(T1, { name: '他人改的名称', revision: 5 }), rows[1]];
    await click(pressable(overlay(), '重读最新版本'));
    await click(pressable(overlay(), '已核对差异，继续编辑'));
    await type('name', '合成调动协议');
    await save();
    expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
      { body: { name: '合成调动协议（新）' }, ifMatch: '3' },
      { body: { name: '合成调动协议' }, ifMatch: '5' },
    ]);
  });

  it('FE-05-16 场景保存 409 后把有效期改回打开时的 2 天：按最新版本发出 2，不当作“没改”吞掉', async () => {
    writes = [
      stale('签署场景设置已被修改，请刷新后重试', 6),
      { body: { scene: 'transfer', validityDays: 2, remindBeforeExpiry: false, revision: 7 } },
    ];
    await open('签署场景设置');
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    await type('validityDays', '7');
    await save();
    scene = { body: { scene: 'transfer', validityDays: 9, remindBeforeExpiry: false, revision: 6 } };
    await click(pressable(overlay(), '重读最新版本'));
    await click(pressable(overlay(), '已核对差异，继续编辑'));
    await type('validityDays', '2');
    await save();
    expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
      { body: { validityDays: 7, remindBeforeExpiry: false }, ifMatch: '4' },
      { body: { validityDays: 2, remindBeforeExpiry: false }, ifMatch: '6' },
    ]);
  });

  it('FE-05-17 停用 409：提示刷新并刷新列表；再点停用带最新版本与新命令 ID', async () => {
    writes = [
      stale('签署模板已被修改，请刷新后重试', 31),
      { body: template(T1, { status: 'disabled', revision: 32 }) },
    ];
    // 409 的尝试按“对象@版本”留在页面级存储里（内核不清锁定态，store.clear），刷新后版本前进便不再命中；
    // 本条用单独的版本段，免得与后面按版本 3 打开的用例撞到同一条目。
    rows = [template(T1, { revision: 30 }), rows[1]];
    await open('设置');
    rows = [template(T1, { revision: 31 }), rows[1]];
    await click(pressable(rowOf('合成调动协议'), '停用'));
    // 陈旧版本按平台统一文案提示（client.ts：REVISION_CONFLICT → refresh），不显示英文原因码
    expect(document.body.textContent).toContain('记录已被更新，请刷新后重新提交');
    expect(document.body.textContent).not.toContain('REVISION_CONFLICT');
    await click(pressable(rowOf('合成调动协议'), '停用'));
    expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
      { body: { status: 'disabled' }, ifMatch: '30' },
      { body: { status: 'disabled' }, ifMatch: '31' },
    ]);
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  // 以下三条结果未知：命令一直钉在页面级存储里，各用不同对象（T1 编辑、T2 启停、场景），互不影响。
  const lost = { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } } };

  it('FE-05-18 模板编辑结果未知：显示待确认并锁定；关闭重开仍锁定，再点保存不另起命令', async () => {
    writes = [lost];
    await open('设置');
    await click(pressable(rowOf('合成调动协议'), '编辑'));
    await type('name', '合成调动协议（新）');
    await save();
    expect(drawer()?.textContent).toContain('结果待确认');
    await click(pressable(overlay(), '取消'));
    expect(drawer()).toBeNull();
    await click(pressable(rowOf('合成调动协议'), '编辑'));
    expect(drawer()?.textContent).toContain('结果待确认');
    expect(pressable(overlay(), '保存')?.disabled).toBe(true);
    await save();
    expect(sent).toHaveLength(1);
    // 同一模板的启停与编辑共用恢复槽：编辑结果未知时停用也锁定，换入口不能另起命令
    await click(pressable(overlay(), '取消'));
    expect(pressable(rowOf('合成调动协议'), '停用')?.disabled).toBe(true);
  });

  it('FE-05-19 启用结果未知：本行显示待确认，按钮锁定，再点不另起命令', async () => {
    writes = [lost];
    await open('设置');
    await click(pressable(rowOf('合成保密协议'), '启用'));
    expect(rowOf('合成保密协议')?.textContent).toContain('结果待确认');
    const again = pressable(rowOf('合成保密协议'), '启用');
    expect(again?.disabled).toBe(true);
    await act(async () => again?.click());
    expect(sent).toEqual([expect.objectContaining({ method: 'PATCH', body: { status: 'enabled' }, ifMatch: '1' })]);
  });

  it('FE-05-20 场景保存结果未知：关闭重开仍锁定，再点保存不另起命令', async () => {
    writes = [lost];
    await open('签署场景设置');
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    await type('validityDays', '7');
    await save();
    expect(drawer()?.textContent).toContain('结果待确认');
    await click(pressable(overlay(), '取消'));
    await click(pressable(rowOf('调动电子签署'), '编辑'));
    expect(drawer()?.textContent).toContain('结果待确认');
    await save();
    expect(sent).toHaveLength(1);
  });

  it('FE-05-21 新建结果未知：锁定不另起命令；关闭时刷新列表供核对，重开新建仍锁定', async () => {
    writes = [lost];
    await open('设置');
    const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(TEMPLATES)).length;
    await click(pressable(host.querySelector('.page-heading'), '新建'));
    await type('name', '合成新协议');
    await type('code', 'SYN-NEW');
    await save();
    expect(drawer()?.textContent).toContain('结果待确认');
    const before = reads();
    await click(pressable(overlay(), '取消'));
    expect(reads()).toBeGreaterThan(before);
    await click(pressable(host.querySelector('.page-heading'), '新建'));
    expect(drawer()?.textContent).toContain('结果待确认');
    await save();
    expect(sent).toHaveLength(1);
  });
});
