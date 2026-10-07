/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const path = resolve('apps/web/src/transfer/ManagerPage.tsx');

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const body = input.endsWith('/manager')
        ? { canApply: true, canViewReporting: false }
        : input.includes('/team')
          ? {
              items: [{ id: 'synthetic', name: '合成员工', employeeStatus: 2, probation: true }],
              counts: { active: 1, probation: 1, intern: 0, pending: 0, leaving: 0 },
            }
          : input.includes('/catalog')
            ? { today: '2026-10-01', types: [], reasons: [] }
            : { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith(label));
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
describe('AC-TRF-42/43 经理工作台入口与只读边界', () => {
  it('纯经理没有汇报关系菜单；抽屉无操作列；调动只在人事申请入口', async () => {
    const { ManagerPage } = await import(path);
    await act(async () => root.render(createElement(ManagerPage)));
    const input = host.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'synthetic-tenant');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await vi.waitFor(() => expect(host.textContent).toContain('团队成员'));
    expect(host.textContent).not.toContain('汇报关系');
    expect(host.textContent).not.toContain('他人调动申请');
    expect(host.querySelectorAll('[role="tab"]').length).toBe(3);
    await click('在岗人员');
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')?.textContent).toContain('合成员工'));
    expect(Array.from(host.querySelectorAll('th')).map((th) => th.textContent)).not.toContain('操作');
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('调动');
    // F-022：试用中按人员状态精确统计，不再显示“待接入人员状态”；人员状态列展示中文
    expect(host.textContent).toContain('试用中：1');
    await click('试用中');
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')?.textContent).toContain('合成员工'));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('试用');
    expect(Array.from(host.querySelectorAll('th')).map((th) => th.textContent)).toContain('人员状态');
    expect(host.textContent).not.toContain('待接入人员状态');
    await click('人事申请');
    await click('他人调动申请');
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/catalog?initiator=manager'))).toBe(
        true,
      ),
    );
  });
});
