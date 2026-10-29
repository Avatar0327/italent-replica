import { describe, expect, it } from 'vitest';
import {
  collectConfigurations,
  isConfigurationPath,
  visibleConfigurationPages,
  type ConfigurationPageDeclaration,
} from './configuration-registry.js';
import { collectPages, lazyPage } from './page-registry.js';
import type { ServerSnapshot } from './permission-snapshot.js';

const flow = {
  id: 'processes',
  label: '流程',
  section: 'workflow',
  access: { app: 'approval', objectCode: 'TenantBase.ApprovalProcess' },
} satisfies ConfigurationPageDeclaration;
const admin = {
  id: 'synthetic-admin',
  label: '合成后台配置',
  section: 'business',
  access: { adminMenu: 'users.all' },
} satisfies ConfigurationPageDeclaration;
const collect = (configurations: readonly ConfigurationPageDeclaration[]) =>
  collectConfigurations([{ module: 'synthetic', configurations }]);
const snapshot = (entryObjects: string[], adminMenus: string[] = []) =>
  ({
    apps: [{ app: 'approval', visible: true, entryObjects }],
    adminMenus: adminMenus.map((code) => ({ code, editable: false })),
  }) as ServerSnapshot;

describe('AC-FE-F320 配置页自注册契约单测', () => {
  it('08 adminMenus 按精确编码只控制对应页，空快照不开放，editable 不授予额外页面', () => {
    const routes = collect([flow, admin]);
    expect(visibleConfigurationPages(routes, snapshot([]))).toEqual([]);
    expect(visibleConfigurationPages(routes, snapshot([], ['users.all']))).toEqual(['synthetic-admin']);
    expect(visibleConfigurationPages(routes, snapshot([], ['users']))).toEqual([]);
    expect(visibleConfigurationPages(routes, snapshot(['TenantBase.ApprovalProcess']))).toEqual(['processes']);
  });
  it('09 各模块在同一个 pages.ts 自注册，排序稳定且页面组件原样挂载', () => {
    const page = lazyPage('SyntheticPage', async () => ({ SyntheticPage: () => null }));
    const moduleA = {
      pages: {
        apps: [{ app: 'approval', label: '审批中心', group: 'work' }],
        configurations: [{ ...flow, page }],
      },
    };
    const moduleB = { pages: { configurations: [admin] } };
    const a = collectPages({ '../a/pages.ts': moduleA, '../b/pages.ts': moduleB }, ['approval']);
    const b = collectPages({ '../b/pages.ts': moduleB, '../a/pages.ts': moduleA }, ['approval']);
    expect(a.configurations).toEqual(b.configurations);
    expect(a.configurations.map((entry) => entry.id)).toEqual(['synthetic-admin', 'processes']);
    expect(a.configurations[1]?.page).toBe(page);
    expect(a.entries).toEqual([]);
    expect(a.ungated.size).toBe(0);
  });
  it('10 拒绝重复 ID、路由模式及不存在的目录或应用对象', () => {
    expect(() => collect([flow, { ...flow, section: 'business' }])).toThrow(/重复/);
    for (const id of ['../settings', ':id', '*', 'PROCESSES', '%70rocesses', 'has/slash'])
      expect(() => collect([{ ...flow, id }])).toThrow(/无效/);
    expect(() => collect([{ ...flow, section: 'unknown' } as unknown as ConfigurationPageDeclaration])).toThrow(/无效/);
    expect(() => collect([{ ...flow, access: { app: 'approval', objectCode: 'TenantBase.Employee' } }])).toThrow(
      /既有应用对象/,
    );
    expect(() => collect([{ ...admin, access: { adminMenu: '' } }])).toThrow(/后台菜单/);
  });
  it('11 配置中心路径匹配覆盖编码、大小写、尾斜杠但不扩大前缀边界', () => {
    for (const path of ['/config-center', '/CONFIG-CENTER/', '/%63onfig-center/workflow/processes'])
      expect(isConfigurationPath(path)).toBe(true);
    for (const path of ['/settings', '/config-center-other', '/config-center%2Fworkflow'])
      expect(isConfigurationPath(path)).toBe(false);
  });
});
