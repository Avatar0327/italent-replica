/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-22（F2a 子项）：企业设置里有「流程矩阵」；没有 matrix.manage 菜单的账号看不到、直达地址无权。
 * 配置中心目录层级部分归 F1，不在本文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttons, click, fakeBackend, harness, text } from './matrix-test-kit.js';

const menus = vi.hoisted(() => ({ children: [] as { key: string; editable: boolean }[] }));
vi.mock('../../foundation/Permissions.js', async (original) => ({
  ...(await original<object>()),
  usePermissions: () => ({ menus: [{ key: 'settings', children: menus.children }] }),
}));

let ui: ReturnType<typeof harness>;
beforeEach(() => {
  ui = harness(fakeBackend());
});
afterEach(async () => ui.close());

describe('AC-APV-F326-22 企业设置挂载流程矩阵', () => {
  it('matrix.manage 持有者：导航出现「流程矩阵」，点开即矩阵页', async () => {
    menus.children = [
      { key: 'permission.admins', editable: true },
      { key: 'matrix.manage', editable: true },
    ];
    await ui.render('/settings/menu/permission.admins');
    expect(buttons()).toContain('流程矩阵');
    await click('流程矩阵');
    expect(text(document.querySelector('.matrix-list') ?? document.body)).toContain('合成矩阵甲');
  });

  it('没有该菜单的账号：导航不出现「流程矩阵」，直达地址显示无权访问且不请求矩阵接口', async () => {
    menus.children = [{ key: 'permission.admins', editable: true }];
    const backend = fakeBackend();
    await ui.close();
    ui = harness(backend);
    await ui.render('/settings/menu/permission.admins');
    expect(buttons()).not.toContain('流程矩阵');
    await ui.remount('/settings/menu/matrix.manage');
    expect(text()).toContain('暂无访问权限');
    expect(backend.reads).toHaveLength(0);
  });
});
