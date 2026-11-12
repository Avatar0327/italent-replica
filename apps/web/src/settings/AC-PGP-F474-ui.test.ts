/// <reference lib="dom" />
// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { objectCatalogDigest, QUALIFICATION_PAGES } from '@italent/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { ProfileDetails } from './ProfileDetails.js';

const pageCode = 'EmployeeDevelopmentChannel';
const carrier = 'Qualification.Pages';
const digest = objectCatalogDigest(QUALIFICATION_PAGES);
const granted = {
  objectCode: carrier,
  fields: [],
  buttons: [{ buttonCode: pageCode, level: 'app_page' }],
  dataOperations: { create: false, update: false, delete: false },
  catalogDigest: digest,
};
let ui: ReturnType<typeof uiHarness>;
let profile: { id: string; name: string; code: string; apps: string[]; revision: number; objects: (typeof granted)[] };
let writes: { path: string; headers: Headers; body: typeof granted }[];
let mode: 'ok' | 'conflict' | 'catalog' | 'unknown' | 'invalid' | 'reject';
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  ui = uiHarness();
  profile = {
    id: randomUUID(),
    name: '合成页面身份',
    code: 'custom',
    apps: ['Qualification'],
    revision: 4,
    objects: [],
  };
  writes = [];
  mode = 'ok';
  close = vi.fn();
});
afterEach(async () => ui.close());
async function click(label: string, role = 'button') {
  const selector = role === 'tab' ? '[role="tab"]' : 'button';
  const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (b) => b.textContent?.replace(/\s/g, '') === label,
  );
  expect(element, label).toBeDefined();
  await act(async () => {
    element!.click();
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
const confirm = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-modal button')).find(
    (b) => b.textContent?.replace(/\s/g, '') === '确定',
  )!;
async function open(editable = true) {
  await ui.render(h(ProfileDetails, { id: profile.id, editable, close }), '/', undefined, {
    [`/api/tenant/permission/profiles/${profile.id}`]: profile,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init?: RequestInit) => {
      const path = new URL(raw, 'http://localhost').pathname;
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push({ path, headers: new Headers(init.headers), body });
        if (mode === 'unknown') throw new Error('lost');
        if (mode === 'invalid') return Response.json({ id: profile.id, revision: profile.revision });
        if (mode === 'reject') return Response.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 400 });
        if (mode === 'conflict' || mode === 'catalog') {
          profile = { ...profile, revision: profile.revision + 1 };
          return Response.json(
            { error: { code: mode === 'catalog' ? 'CATALOG_CHANGED' : 'REVISION_CONFLICT' } },
            { status: 409 },
          );
        }
        profile = {
          ...profile,
          revision: Number(new Headers(init.headers).get('if-match')?.replaceAll('"', '')) + 1,
          objects: [{ ...body, objectCode: carrier }],
        };
        return Response.json(profile);
      }
      if (path.endsWith('/data-operations'))
        return Response.json({
          profileId: profile.id,
          objectCode: 'Qualification.X',
          revision: profile.revision,
          dataOperations: { create: false, update: false, delete: false },
        });
      return Response.json(profile);
    }),
  );
  await click('页面权限', 'tab');
}
async function add() {
  await click('新增');
  const checkbox = document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]');
  expect(checkbox).not.toBeNull();
  await act(() => checkbox!.click());
  await click('确定');
}
describe('AC-PGP-F474 页面权限与菜单组交互', () => {
  it('AC-PGP-F474-04、05 正常新增只写载体，带指纹、revision、命令ID，刷新显示已授予', async () => {
    await open();
    await add();
    expect(writes).toHaveLength(1);
    const request = writes[0]!;
    expect(request.path).toBe(`/api/tenant/permission/profiles/${profile.id}/objects/Qualification.Pages`);
    expect(request.headers.get('if-match')?.replaceAll('"', '')).toBe('4');
    expect(request.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.body).toEqual({
      fields: [],
      buttons: [{ buttonCode: pageCode, level: 'app_page' }],
      dataOperations: { create: false, update: false, delete: false },
      catalogDigest: digest,
    });
    expect(document.querySelector('.ant-modal')).toBeNull();
    expect(ui.host.textContent).toContain('已授予');
    expect(ui.host.textContent).toContain('多个身份');
  });
  it('AC-PGP-F474-06 删除确认后空按钮保留载体，取消无写入', async () => {
    profile.objects = [granted];
    await open();
    await click('删除');
    expect(document.querySelector('.ant-modal')?.textContent).toContain('删除后持有该身份的用户立即失去该页面');
    await click('取消');
    expect(writes).toHaveLength(0);
    await click('删除');
    await click('确定');
    expect(writes[0]!.body.buttons).toEqual([]);
    expect(profile.objects).toHaveLength(1);
  });
  it('AC-PGP-F474-08 员工缺行显示默认授予，删除默认页面才显式清空', async () => {
    profile.code = 'employee_self_service';
    await open();
    expect(ui.host.textContent).toContain('默认授予（未显式配置）');
    await click('删除');
    await click('确定');
    expect(writes[0]!.body.buttons).toEqual([]);
    expect(ui.host.textContent).not.toContain('默认授予（未显式配置）');
  });
  it('AC-PGP-F474-10 缺应用禁用候选，显示前置提示，普通身份不默认授予', async () => {
    profile.apps = [];
    await open();
    expect(ui.host.textContent).toContain('缺前置');
    expect(ui.host.textContent).toContain('需先在应用范围中加入');
    expect(ui.host.textContent).not.toContain('默认授予');
    await click('新增');
    expect(document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]')?.disabled).toBe(true);
    expect(confirm().disabled).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it('AC-PGP-F474-04 名称与编码筛选候选，只读身份无增删按钮', async () => {
    await open();
    await click('新增');
    const input = document.querySelector<HTMLInputElement>('.ant-modal input[type="text"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const [query, count] of [
      ['不存在', 0],
      ['employeedevelopment', 1],
      ['员工发展', 1],
    ] as const) {
      await act(() => {
        setter.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(document.querySelectorAll('.ant-modal input[type="checkbox"]')).toHaveLength(count);
    }
    await click('取消');
    await ui.close();
    ui = uiHarness();
    profile.objects = [granted];
    await open(false);
    const text = Array.from(ui.host.querySelectorAll('button')).map((b) => b.textContent?.replace(/\s/g, ''));
    expect(text).not.toContain('新增');
    expect(text).not.toContain('删除');
  });
  it.each(['conflict', 'catalog'] as const)(
    'AC-PGP-F474-09 %s 不自动重试，重读核对后保留选择并用新版本提交',
    async (failure) => {
      await open();
      mode = failure;
      await add();
      expect(writes).toHaveLength(1);
      expect(confirm().disabled).toBe(true);
      await click('重读最新版本');
      await click('已核对差异，继续编辑');
      expect(document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]')?.checked).toBe(true);
      mode = 'ok';
      await click('确定');
      expect(writes).toHaveLength(2);
      expect(writes[1]!.headers.get('if-match')?.replaceAll('"', '')).toBe('5');
      expect(writes[1]!.headers.get('idempotency-key')).not.toBe(writes[0]!.headers.get('idempotency-key'));
    },
  );
  it('AC-PGP-F474-09 确定拒绝保留勾选，改回原选择后能重提', async () => {
    await open();
    mode = 'reject';
    await add();
    expect(confirm().disabled).toBe(false);
    const checkbox = document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    await act(() => checkbox.click());
    expect(confirm().disabled).toBe(true);
    await act(() => checkbox.click());
    mode = 'ok';
    await click('确定');
    expect(writes).toHaveLength(2);
  });
  it.each(['unknown', 'invalid'] as const)(
    'AC-PGP-F474-09 %s 关闭重开和导航返回保持锁，回查后原请求重放',
    async (failure) => {
      await open();
      mode = failure;
      await add();
      expect(confirm().disabled).toBe(true);
      await click('取消');
      await click('对象权限', 'tab');
      await click('页面权限', 'tab');
      await click('新增');
      expect(confirm().disabled).toBe(true);
      await click('取消');
      await ui.close();
      ui = uiHarness();
      await open();
      await click('新增');
      expect(confirm().disabled).toBe(true);
      expect(writes).toHaveLength(1);
      await click('回查原单');
      mode = 'ok';
      await click('按原请求重试');
      await tick();
      expect(writes).toHaveLength(2);
      expect(writes[1]!.headers.get('idempotency-key')).toBe(writes[0]!.headers.get('idempotency-key'));
      expect(writes[1]!.headers.get('if-match')).toBe(writes[0]!.headers.get('if-match'));
      expect(writes[1]!.body).toEqual(writes[0]!.body);
    },
  );
  it('AC-PGP-F474-09 服务端与共享目录指纹不符时禁止保存', async () => {
    profile.objects = [{ ...granted, buttons: [], catalogDigest: '0000000000000000' }];
    await open();
    await click('新增');
    expect(document.querySelector('.ant-modal')?.textContent).toContain('页面资源');
    expect(confirm().disabled).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it('AC-PGP-F474-11 菜单按目录对象顺序推导，载体只出现在页面与菜单页签', async () => {
    profile.objects = [granted];
    await open();
    await click('对象权限', 'tab');
    expect(ui.host.querySelector('tbody')?.textContent ?? '').not.toContain(carrier);
    await click('菜单组', 'tab');
    expect(ui.host.textContent).toContain('由对象权限推导，调整请在对象权限中修改');
    expect(ui.host.textContent).toContain(carrier);
    expect(ui.host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(ui.host.textContent).not.toContain('保存');
    expect(writes).toHaveLength(0);
  });
  it('AC-PGP-F474-09 页面结果未知时切到对象数据操作弹窗仍锁定', async () => {
    profile.objects = [{ ...granted, objectCode: 'Qualification.X', buttons: [] }];
    await open();
    mode = 'unknown';
    await add();
    await click('取消');
    await click('对象权限', 'tab');
    await click('数据操作权限');
    expect(confirm().disabled).toBe(true);
    expect(document.querySelector('.ant-modal')?.textContent).toContain('未确认的其他操作');
    expect(writes).toHaveLength(1);
  });
  it('AC-PGP-F474-09 删除冲突重读后继续显式删除，保留空选择并使用新版本', async () => {
    profile.objects = [granted];
    await open();
    mode = 'conflict';
    await click('删除');
    await click('确定');
    await click('重读最新版本');
    await click('已核对差异，继续编辑');
    mode = 'ok';
    await click('确定');
    expect(writes[1]!.body.buttons).toEqual([]);
    expect(writes[1]!.headers.get('if-match')?.replaceAll('"', '')).toBe('5');
  });
  it('AC-PGP-F474-09 删除回执丢失后重开保持锁，先回查再重放同一空按钮请求', async () => {
    profile.objects = [granted];
    await open();
    mode = 'unknown';
    await click('删除');
    await click('确定');
    await click('取消');
    await click('删除');
    expect(confirm().disabled).toBe(true);
    await click('回查原单');
    mode = 'ok';
    await click('按原请求重试');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(writes[1]!.headers.get('idempotency-key')).toBe(writes[0]!.headers.get('idempotency-key'));
  });
  it('AC-PGP-F474-09 离开后迟到成功不关闭新页面，回来读取已保存配置', async () => {
    await open();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    await click('新增');
    await act(() => document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]')!.click());
    await click('确定');
    await ui.close();
    profile = { ...profile, revision: 5, objects: [granted] };
    await act(async () => {
      resolve(Response.json(profile));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(close).not.toHaveBeenCalled();
    ui = uiHarness();
    await open();
    expect(ui.host.textContent).toContain('已授予');
    await click('删除');
    expect(confirm().disabled).toBe(false);
  });
});
