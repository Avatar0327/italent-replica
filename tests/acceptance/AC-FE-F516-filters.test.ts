/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from './support/f474-ui.js';
const { GrantsPage } = await import(resolve('apps/web/src/settings/GrantsPage.tsx'));
const { UsersPage } = await import(resolve('apps/web/src/settings/UsersPage.tsx'));
const { AdminsPage } = await import(resolve('apps/web/src/settings/AdminsPage.tsx'));

const base = '/api/tenant/permission';
const ids = ['10000000-0000-4000-8000-000000000516', '20000000-0000-4000-8000-000000000516'];
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
};
const queries = () => vi.mocked(fetch).mock.calls.map(([raw]) => new URL(String(raw), 'http://localhost'));
async function open(label: string) {
  const input = ui.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await tick();
  });
  return input;
}
async function choose(name: string) {
  const option = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find(
    (item) => item.textContent === name,
  );
  expect(option).toBeDefined();
  await act(async () => {
    option!.click();
    await tick();
  });
}
async function search(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
  });
}
async function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.replace(/\s/g, '') === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await tick();
  });
}

describe.each([
  { resource: 'grants', component: GrantsPage, label: '身份', candidate: 'profile-candidates', key: 'profileId' },
  { resource: 'grants', component: GrantsPage, label: '管理单元', candidate: 'mou-candidates', key: 'mouId' },
  { resource: 'admins', component: AdminsPage, label: '管理单元', candidate: 'mou-candidates', key: 'mouId' },
])('AC-FE-F516 $resource $label', ({ resource, component, label, candidate, key }) => {
  const path = `${base}/${resource}/${candidate}`;
  async function render() {
    await ui.render(h(component, { title: '筛选列表', editable: false, canScope: false }), '/', undefined, {
      [`${base}/${resource}`]: { items: [], total: 0 },
      [path]: (url: URL) =>
        url.searchParams.has('q')
          ? { items: [], total: 0 }
          : { items: ids.map((id, index) => ({ id, name: `页外候选${index}` })), total: 2 },
    });
  }
  it('独立加载页外候选，多选发送重复参数，清空取消条件', async () => {
    await render();
    await open(label);
    expect(queries().some((url) => url.pathname === path)).toBe(true);
    await choose('页外候选0');
    await choose('页外候选1');
    await clickButton('查询');
    expect(
      queries()
        .filter((url) => url.pathname === `${base}/${resource}`)
        .at(-1)!
        .searchParams.getAll(key),
    ).toEqual(ids);
    await clickButton('清空');
    expect(
      queries()
        .filter((url) => url.pathname === `${base}/${resource}`)
        .at(-1)!
        .searchParams.has(key),
    ).toBe(false);
    expect(queries().some((url) => url.pathname.endsWith('grantable-profiles'))).toBe(false);
  });
  it('搜索走服务端并显示空状态', async () => {
    await render();
    const input = await open(label);
    await search(input, '未匹配');
    expect(queries().some((url) => url.pathname === path && url.searchParams.get('q') === '未匹配')).toBe(true);
    expect(document.body.textContent).toContain('没有匹配的数据');
  });
});

describe('AC-FE-F516 候选翻页与异步生命周期', () => {
  const path = `${base}/admins/mou-candidates`;
  const render = async () =>
    ui.render(h(AdminsPage, { title: '管理员', editable: false }), '/', undefined, {
      [`${base}/admins`]: { items: [], total: 0 },
      [path]: (url: URL) => ({
        items: [
          {
            id: ids[url.searchParams.get('offset') === '50' ? 1 : 0],
            name: url.searchParams.get('offset') === '50' ? '第二页' : '第一页',
          },
        ],
        total: 51,
      }),
    });
  it('跨候选页保留已选名称与值，搜索回到第一页', async () => {
    await render();
    const input = await open('管理单元');
    await choose('第一页');
    await clickButton('下一页');
    expect(
      queries()
        .filter((url) => url.pathname === path)
        .at(-1)!
        .searchParams.get('offset'),
    ).toBe('50');
    await choose('第二页');
    expect(ui.host.textContent).toContain('第一页');
    expect(ui.host.textContent).toContain('第二页');
    await clickButton('查询');
    expect(
      queries()
        .filter((url) => url.pathname === `${base}/admins`)
        .at(-1)!
        .searchParams.getAll('mouId'),
    ).toEqual(ids);
    await search(input, '检索');
    expect(
      queries()
        .filter((url) => url.pathname === path)
        .at(-1)!
        .searchParams.get('offset'),
    ).toBe('0');
  });
  it('旧搜索迟到不能覆盖新结果，失败有重试出口，卸载后迟到不回写', async () => {
    await render();
    const input = await open('管理单元');
    let release: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((raw) => {
      const url = new URL(String(raw), 'http://localhost');
      if (url.searchParams.get('q') === '旧')
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (url.searchParams.get('q') === '失败')
        return Promise.resolve(Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503 }));
      return Promise.resolve(Response.json({ items: [{ id: ids[1], name: '最新候选' }], total: 1 }));
    });
    await search(input, '旧');
    expect(document.body.textContent).toContain('正在加载');
    await search(input, '新');
    await act(async () => {
      release!(Response.json({ items: [{ id: ids[0], name: '过期候选' }], total: 1 }));
      await tick();
    });
    expect(document.body.textContent).toContain('最新候选');
    expect(document.body.textContent).not.toContain('过期候选');
    await search(input, '失败');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    vi.mocked(fetch).mockResolvedValue(Response.json({ items: [], total: 0 }));
    await clickButton('重新加载');
    expect(document.body.textContent).toContain('没有匹配的数据');
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await search(input, '离开');
    await ui.render(h('div', null, '已离开'));
    await act(async () => {
      release!(Response.json({ items: [{ id: ids[0], name: '离开后结果' }], total: 1 }));
      await tick();
    });
    expect(document.body.textContent).not.toContain('离开后结果');
  });
});

it('AC-FE-F516 共用查询编码仍允许筛选覆盖固定 type', async () => {
  await ui.render(h(UsersPage, { code: 'users.all', title: '全部用户', editable: false }));
  await open('用户类型');
  await choose('外部用户');
  await clickButton('查询');
  expect(
    queries()
      .filter((url) => url.pathname === `${base}/users`)
      .at(-1)!
      .searchParams.getAll('type'),
  ).toEqual(['external']);
});
