import { describe, expect, it } from 'vitest';
import { APP_IDS } from '../../packages/domain/src/permission/app-directory.js';
import {
  collectConfigurations,
  CONFIGURATION_SECTIONS,
  visibleConfigurationPages,
  type ConfigurationPageDeclaration,
} from '../../apps/web/src/foundation/configuration-registry.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import type { ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';

// 使用 unknown 接住尚未实现的声明，红测验证行为而非编译错误。
const collect = (...entries: unknown[]) =>
  collectConfigurations([{ module: 'synthetic', configurations: entries as ConfigurationPageDeclaration[] }]);
const base = { id: 'synthetic-config', label: '合成配置', access: { adminMenu: 'matrix.manage' } };
const globalEntry = { ...base, placement: { kind: 'global' } };
const application = (app: string) => ({ ...base, placement: { kind: 'app', app }, section: 'workflow' });

describe('AC-APV-F326-21 配置中心共享契约', () => {
  it('缺省归属组织员工，既有全部目录路径与流程链接保持一致', () => {
    for (const section of CONFIGURATION_SECTIONS) {
      const [route] = collect({ ...base, section });
      expect(route).toMatchObject({ placement: { kind: 'app', app: 'staff' } });
      expect(route?.path).toBe(`/config-center/${section}/synthetic-config`);
    }
    expect(PAGES.configurations.find((route) => route.id === 'processes')?.path).toBe(
      '/config-center/workflow/processes',
    );
  });

  it('全局项直接挂载，所有应用按目录键生成路径', () => {
    expect(collect(globalEntry)[0]?.path).toBe('/config-center/global/synthetic-config');
    for (const app of APP_IDS) {
      const prefix = app === 'staff' ? '/config-center' : `/config-center/apps/${app}`;
      expect(collect(application(app))[0]?.path).toBe(`${prefix}/workflow/synthetic-config`);
    }
  });

  it('全局项禁止 section，应用项必须带合法 section，拒绝未知 placement 和应用', () => {
    for (const section of [...CONFIGURATION_SECTIONS, undefined])
      expect(() => collect({ ...globalEntry, section })).toThrow(/无效/);
    for (const entry of [
      base,
      { ...application('staff'), section: undefined },
      { ...application('staff'), section: 'unknown' },
      application('unknown'),
      { ...application('staff'), placement: { kind: 'unknown' } },
    ])
      expect(() => collect(entry)).toThrow(/无效/);
  });

  it.each(['global', 'apps'])('保留字 %s 即使误加入目录常量也必须被登记校验拒绝', (section) => {
    const sections = CONFIGURATION_SECTIONS as unknown as string[];
    sections.push(section);
    try {
      expect(() => collect({ ...application('staff'), section })).toThrow(/无效/);
    } finally {
      sections.pop();
    }
  });

  it('全局与各应用之间 ID 仍全局唯一，拒绝路径模式及编码别名', () => {
    expect(() => collect(globalEntry, application('transfer'))).toThrow(/重复/);
    expect(() => collect(application('staff'), application('transfer'))).toThrow(/重复/);
    for (const id of ['', '../settings', ':id', '*', 'UPPER', '%61', 'has/slash'])
      expect(() => collect({ ...globalEntry, id })).toThrow(/无效/);
    expect(collect()).toEqual([]);
  });

  it('排序为全局项、APP_IDS 应用顺序、目录顺序、ID，声明顺序不影响结果', () => {
    const entries = [
      { ...application('transfer'), id: 'transfer-config' },
      { ...application('staff'), id: 'staff-z' },
      { ...application('staff'), id: 'staff-a' },
      { ...application('org'), id: 'org-config' },
      { ...globalEntry, id: 'global-z' },
      { ...globalEntry, id: 'global-a' },
      { ...application('staff'), id: 'staff-business', section: 'business' },
    ];
    const routes = collect(...entries);
    expect(routes).toEqual(collect(...entries.toReversed()));
    expect(routes.map((route) => route.id)).toEqual([
      'global-a',
      'global-z',
      'org-config',
      'staff-business',
      'staff-a',
      'staff-z',
      'transfer-config',
    ]);
  });

  it('placement 不授予权限，后台菜单与对象权限仍分别判定，空快照关闭全部入口', () => {
    const routes = collect(globalEntry, {
      ...application('transfer'),
      id: 'object-config',
      access: { app: 'approval', objectCode: 'TenantBase.ApprovalProcess' },
    });
    const snapshot = {
      apps: [{ app: 'approval', visible: true, entryObjects: ['TenantBase.ApprovalProcess'] }],
      adminMenus: [],
    } as unknown as ServerSnapshot;
    expect(visibleConfigurationPages(routes, snapshot)).toEqual(['object-config']);
    expect(visibleConfigurationPages(routes, { ...snapshot, apps: [] })).toEqual([]);
    expect(
      visibleConfigurationPages(routes, {
        ...snapshot,
        apps: [],
        adminMenus: [{ code: 'matrix.manage', path: '流程矩阵', editable: false, implemented: true }],
      }),
    ).toEqual(['synthetic-config']);
  });
});
