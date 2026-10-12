/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
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

describe('AC-FE-0-09 原站参考包模板契约', () => {
  it('列表通过图标旁的视图下拉切换，由调用方控制当前视图', async () => {
    const { ListPage } = await import(resolve('apps/web/src/foundation/templates.tsx'));
    const change = vi.fn();
    const render = (value: string) =>
      h(ListPage, {
        title: '组织',
        view: {
          value,
          options: [
            { key: 'enabled', label: '启用的组织' },
            { key: 'disabled', label: '停用的组织' },
          ],
          onChange: change,
        },
        data: { items: [], total: 0 },
        columns: [],
        rowKey: 'id',
        page: { page: 1, pageSize: 15 },
        onPageChange: vi.fn(),
      });
    await act(() => root.render(render('enabled')));
    expect(host.querySelector('h1')?.textContent).toContain('启用的组织');
    expect(host.querySelector('.page-view-icon')).not.toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="切换视图"]')!.click());
    const disabled = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('停用的组织'),
    );
    await act(() => disabled!.click());
    expect(change).toHaveBeenCalledWith('disabled');
    await act(() => root.render(render('disabled')));
    expect(host.querySelector('h1')?.textContent).toContain('停用的组织');
  });

  it('详情在右侧对话抽屉内展示摘要、页签和分区，关闭后保留原列表', async () => {
    const { DetailPage } = await import(resolve('apps/web/src/foundation/templates.tsx'));
    const close = vi.fn();
    const tree = (open: boolean) =>
      h('main', {}, [
        h('p', { key: 'list' }, '原列表仍在'),
        h(DetailPage, {
          key: 'detail',
          open,
          onClose: close,
          title: '合成组织',
          summary: '组织摘要',
          tabs: [
            { key: 'base', label: '组织单元', children: '单元内容' },
            { key: 'history', label: '变更记录', children: '历史内容' },
          ],
          sections: [{ key: 'parent', title: '上级组织', children: '合成上级' }],
        }),
      ]);
    await act(() => root.render(tree(true)));
    const drawer = document.querySelector('.ant-drawer-right');
    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('[role="dialog"]')?.textContent).toContain('合成上级');
    expect(drawer?.textContent).toContain('组织摘要');
    const tab = Array.from(drawer!.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) =>
      el.textContent?.includes('变更记录'),
    );
    await act(() => tab!.click());
    expect(drawer?.querySelector('.ant-tabs-tabpane-active')?.textContent).toBe('历史内容');
    await act(() => drawer!.querySelector<HTMLButtonElement>('.ant-drawer-close')!.click());
    expect(close).toHaveBeenCalledOnce();
    await act(() => root.render(tree(false)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toBe('原列表仍在');
  });

  it('高级筛选提供清空、取消、确定三个独立动作，取消不会应用条件', async () => {
    const { FilterDrawer } = await import(resolve('apps/web/src/foundation/FilterDrawer.tsx'));
    const clear = vi.fn();
    const close = vi.fn();
    const apply = vi.fn();
    await act(() =>
      root.render(h(FilterDrawer, { open: true, onClear: clear, onClose: close, onApply: apply }, '合成筛选项')),
    );
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-drawer-footer button'));
    const click = (name: string) =>
      buttons()
        .find((button) => button.textContent?.replace(/\s/g, '') === name)!
        .click();
    await act(() => click('清空'));
    expect(clear).toHaveBeenCalledOnce();
    await act(() => click('取消'));
    expect(close).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    await act(() => click('确定'));
    expect(apply).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>('.ant-drawer-content-wrapper')?.style.width).toBe('500px');
  });
});
