/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-132 第 1 段 #326 第 2 轮：原站整页无权限状态在提示下方给“刷新页面”主按钮；抽屉内的无权限提示不带刷新。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { PageState } = await import(resolve('apps/web/src/foundation/PageState.tsx'));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const render = (props: Record<string, unknown>) =>
  act(() => root.render(h(MemoryRouter, null, h(PageState, { kind: 'forbidden', ...props }))));
const buttons = () =>
  Array.from(host.querySelectorAll('button')).map((button) => button.textContent?.replace(/\s/g, ''));

describe('AC-FE-0-06 整页无权限可刷新', () => {
  it('传入 refresh 时显示“刷新页面”，点击重新获取权限', async () => {
    const refresh = vi.fn();
    await render({ refresh });
    expect(host.textContent).toContain('暂无访问权限');
    expect(buttons()).toEqual(['刷新页面']);
    await act(() => host.querySelector('button')!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('未传 refresh（抽屉等局部用法）不显示刷新按钮', async () => {
    await render({});
    expect(buttons()).toEqual([]);
  });
});
