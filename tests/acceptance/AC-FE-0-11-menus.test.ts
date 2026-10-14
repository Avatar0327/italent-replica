// F-132 第 1 段 #326 第 2 轮：全部菜单搜索与当前应用。
// 原站：搜索结果平铺显示“搜索结果 N”，每行是命中的菜单名与右侧路径（应用 > 上级 > …），下级菜单同样可搜到；
// 顶栏应用切换显示应用名，左侧导航只列当前应用的菜单。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { searchMenus, currentApp } = await import(resolve('apps/web/src/foundation/menu-nav.ts'));
const groups = { people: '组织员工', talent: '人才管理', settings: '设置' };
const menus = [
  { key: 'org', label: '组织管理', path: '/org', group: 'people' },
  { key: 'staff', label: '员工', path: '/staff', group: 'people' },
  { key: 'talent-review', label: '人才盘点', path: '/talent-review', group: 'talent' },
  {
    key: 'settings',
    label: '企业设置',
    path: '/settings',
    group: 'settings',
    children: [
      { key: 'users.all', label: '用户管理/全部用户', path: '/settings/menu/users.all', group: 'settings' },
      { key: 'profiles', label: '身份管理', path: '/settings/menu/profiles', group: 'settings' },
    ],
  },
];

describe('AC-FE-0-11 全部菜单搜索', () => {
  it('递归搜索下级菜单，命中“全部用户”并给出应用 > 上级 > 目录路径', () => {
    expect(searchMenus(menus, '全部用户', groups)).toEqual([
      {
        key: 'users.all',
        label: '全部用户',
        path: '/settings/menu/users.all',
        trail: ['设置', '企业设置', '用户管理'],
      },
    ]);
  });

  it('同时返回一级与下级命中，按菜单树顺序平铺；一级菜单路径只有应用名', () => {
    expect(searchMenus(menus, '管理', groups)).toEqual([
      { key: 'org', label: '组织管理', path: '/org', trail: ['组织员工'] },
      { key: 'profiles', label: '身份管理', path: '/settings/menu/profiles', trail: ['设置', '企业设置'] },
    ]);
  });

  it('只搜传入的（已按权限裁剪的）菜单；空关键字不出结果，前后空格忽略', () => {
    expect(searchMenus(menus.slice(0, 3), '全部用户', groups)).toEqual([]);
    expect(searchMenus(menus, '   ', groups)).toEqual([]);
    expect(searchMenus(menus, ' 人才盘点 ', groups).map((hit: { key: string }) => hit.key)).toEqual(['talent-review']);
  });
});

describe('AC-FE-0-11 当前应用', () => {
  it('按当前菜单定位应用：名称取应用名而不是页面名，菜单只含本应用', () => {
    const app = currentApp(menus, '/staff', groups);
    expect(app?.label).toBe('组织员工');
    expect(app?.menus.map((menu: { key: string }) => menu.key)).toEqual(['org', 'staff']);
    expect(currentApp(menus, '/settings', groups)?.menus.map((menu: { key: string }) => menu.key)).toEqual([
      'settings',
    ]);
  });

  it('当前路径不属于任何有权菜单时没有当前应用', () => {
    expect(currentApp(menus, undefined, groups)).toBeUndefined();
    expect(currentApp(menus, '/job', groups)).toBeUndefined();
  });
});
