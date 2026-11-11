/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from './support/f474-ui.js';
import { GrantsPage } from '../../apps/web/src/settings/GrantsPage.js';
import { AdminsPage } from '../../apps/web/src/settings/AdminsPage.js';

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
    (item) => item.textContent?.trim() === text,
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
