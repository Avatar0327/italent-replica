/**
 * F-125（DEC-476 / DEC-492①）：页面、路由、菜单与注释改为各模块自带登记文件，底座自动汇总。
 * 迁移前快照逐项写在下面，基线取合入 main 3e8dd11（含 #298 #296 #315 #318）后、迁移前的 AppPages.tsx / routes.ts /
 * messages.ts / permission-snapshot.ts / annotations/*.ts 汇总结果，
 * 迁移后逐项比对；应用是后端固定集合，逐行全等；入口、子路由与注释只校验“迁移前条目仍在且不变”，新片追加不用改本文件。
 * 有意改动已有条目（如把旧页面换成新页面、去掉 legacy 布局）时，改对应一行即可。
 */
import { APP_IDS } from '@italent/domain';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { annotationOwners, annotations, collectAnnotations } from '../../apps/web/src/annotations/index.js';
import {
  collectPages,
  mountPath,
  type EntryRoute,
  type ModulePage,
} from '../../apps/web/src/foundation/page-registry.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { APP_ROUTES, MENU_ROUTES, PAGES, SUB_ROUTES, appRoute } from '../../apps/web/src/foundation/routes.js';

const SRC = fileURLToPath(new URL('../../apps/web/src/', import.meta.url));

// 应用：id | 菜单名 | 分组 | 主对象 | 模块:页面导出名 | 布局
const APPS_BEFORE = [
  'org|组织管理|people|TenantBase.Organization|org:OrgPage|-',
  'job|职务体系|people|TenantBase.JobPost|job:JobWorkspace|-',
  'staff|员工|people|TenantBase.Employee|personnel:StaffPage|-',
  'transfer|调动管理|people|TenantBase.EmploymentRecord|transfer:TransferPage|-',
  'approval|审批中心|work|-|approval:ApprovalPage|-',
  'self|员工自助|work|-|self-service:SelfPage|-',
  'manager|管理者工作台|work|-|self-service:ManagerPage|-',
  'settings|企业设置|settings|-|settings:SettingsPage|legacy',
  'talent|人才标准|talent|TalentCenter.DimensionLibrary|talent:TalentPage|legacy',
  'qualification|任职资格|talent|Qualification.EmploymentCategory|qualification:QualificationPage|legacy',
  'evaluation|人才评定|talent|TEvaluation.EvaluationActivity|evaluation:EvaluationPage|-',
  'survey360|360 评估|talent|Survey360.Activity|survey360:SurveyPage|-',
  'talent-review|人才盘点|talent|TalentReview.Project|talent-review:TalentReviewPage|legacy',
  'succession|继任管理|talent|Succession.Map|succession:SuccessionPage|-',
  'idp|人才发展计划|talent|IDP.IDPTemplate|idp:IdpPage|-',
];
// 子路由：路径 | 模块:页面导出名 | 布局 | 是否按菜单可见性拦截
const ROUTES_BEFORE = [
  '/manager/*|self-service:ManagerPage|-|gated',
  '/org/changes|org:OrgPage|-|gated',
  '/self/*|self-service:SelfPage|-|gated',
  '/settings/account|account:AccountPage|legacy|ungated',
  '/settings/menu/:code|settings:SettingsPage|-|gated',
];
// 应用内入口：id | 菜单名 | 分组 | 对象 | 模块:页面导出名 | 布局 | 所属应用 | 挂载路径
const ENTRIES_BEFORE = [
  'contracts|合同协议|people|TenantBase.EmploymentContract|contracts:ContractsPage|-|staff|/contracts/*',
];
// 注释键 → 所属模块
const NOTES_BEFORE: Record<string, string> = {
  approval: 'approval',
  contracts: 'contracts',
  establishment: 'establishment',
  evaluation: 'evaluation',
  'evaluation-paused': 'evaluation',
  foundation: 'foundation',
  job: 'job',
  org: 'org',
  'org-change': 'org',
  personnel: 'personnel',
  'qualification-category': 'qualification',
  'qualification-level': 'qualification',
  'qualification-standard': 'qualification',
  'qualification-channel': 'qualification',
  'personnel-records': 'personnel',
  'personnel-filters': 'personnel',
  'self.profile': 'self-service',
  'self.applications': 'self-service',
  'manager.team': 'self-service',
  'manager.todos': 'self-service',
  settings: 'settings',
  'settings.snapshot': 'settings',
  survey360: 'survey360',
  'talent-maintenance': 'talent',
  'talent-library': 'talent',
  'talent-dimension': 'talent',
  'talent-criterion': 'talent',
  'talent-review-projects': 'talent-review',
  'talent-review-templates': 'talent-review',
  'talent-review-matrices': 'talent-review',
  'talent-review-demo': 'talent-review',
  transfer: 'transfer',
  'transfer-form': 'transfer',
};

const page = (module: string, item?: ModulePage) => `${module}:${item?.name ?? '空首页'}`;
const appRow = (route: (typeof APP_ROUTES)[number]) =>
  [route.id, route.label, route.group, route.objectCode ?? '-', page(route.module, route.page)]
    .concat(route.legacy ? 'legacy' : '-')
    .join('|');
const subRow = (route: (typeof SUB_ROUTES)[number]) =>
  [route.path, page(route.module, route.page), route.legacy ? 'legacy' : '-', route.ungated ? 'ungated' : 'gated'].join(
    '|',
  );

describe('AC-FE-F125-01 汇总结果与迁移前逐项一致', () => {
  it('应用路由逐行相等，顺序跟后端应用目录一致', () => {
    expect(APP_ROUTES.map(appRow)).toEqual(APPS_BEFORE);
    expect(APP_ROUTES.map((route) => route.id)).toEqual([...APP_IDS]);
    expect(APP_ROUTES.map((route) => route.path)).toEqual(APP_IDS.map((id) => `/${id}`));
  });
  it.each(ENTRIES_BEFORE)('应用内入口 %s 仍在且不变', (row) => {
    const rows = PAGES.entries.map((route) =>
      [route.id, route.label, route.group, route.objectCode, page(route.module, route.page)]
        .concat(route.legacy ? 'legacy' : '-', route.app, mountPath(route))
        .join('|'),
    );
    expect(rows).toContain(row);
  });
  it.each(ROUTES_BEFORE)('子路由 %s 仍在且不变', (row) => {
    expect(SUB_ROUTES.map(subRow)).toContain(row);
  });
  it.each(Object.entries(NOTES_BEFORE))('注释 %s 仍由 %s 模块登记', (key, module) => {
    expect(annotationOwners[key]).toBe(module);
    expect(annotations[key]).toEqual(
      expect.objectContaining({ original: expect.any(String), decision: expect.any(String) }),
    );
  });
  it('旧路径跳转与个人设置入口不变', () => {
    expect(appRoute('/org/changes')?.id).toBe('org');
    expect(appRoute('/settings/account')?.id).toBe('settings');
    expect([...PAGES.ungated]).toEqual(['/settings/account']);
  });
});

describe('AC-FE-F125-02 无重复路由 id / path / 菜单键 / 注释键', () => {
  it('实际登记无重复', () => {
    const ids = MENU_ROUTES.map((route) => route.id);
    const paths = [...MENU_ROUTES, ...SUB_ROUTES].map((route) => route.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(Object.keys(annotations)).toEqual(Object.keys(annotationOwners));
  });
  const lazy = { name: 'P', Component: (() => null) as unknown as ModulePage['Component'] };
  const app = (id: string) => ({ app: id, label: id, group: 'work' });
  const all = (extra: object = {}) => ({ '../base/pages.ts': { pages: { apps: APP_IDS.map(app), ...extra } } });
  const collect = (modules: Record<string, unknown>) => () => collectPages(modules, APP_IDS);

  it('同一应用登记两次、未知应用、缺登记、缺导出都报错', () => {
    expect(collect({ ...all(), '../dup/pages.ts': { pages: { apps: [app('org')] } } })).toThrow(/重复.*org/);
    expect(collect(all({ apps: [...APP_IDS.map(app), app('ghost')] }))).toThrow(/未知应用.*ghost/);
    expect(collect({ '../base/pages.ts': { pages: { apps: APP_IDS.slice(1).map(app) } } })).toThrow(/缺少.*org/);
    expect(collect({ ...all(), '../empty/pages.ts': {} })).toThrow(/empty.*pages/);
  });
  it('子路由路径与应用 / 入口 / 子路由重复都报错', () => {
    const route = (path: string) => ({ path, page: lazy });
    expect(collect(all({ routes: [route('/x'), route('/x')] }))).toThrow(/重复.*\/x/);
    expect(collect(all({ routes: [route('/org')] }))).toThrow(/重复.*\/org/);
    const entry = (id: string) => ({ id, app: 'staff', label: id, group: 'people', objectCode: 'X', page: lazy });
    expect(collect(all({ entries: [entry('staff')] }))).toThrow(/重复.*staff/);
    expect(collect(all({ entries: [entry('e'), entry('e')] }))).toThrow(/重复.*e/);
  });
  it('排序确定：不依赖文件遍历顺序', () => {
    const entry = (id: string) => ({ id, app: 'staff', label: id, group: 'people', objectCode: id, page: lazy });
    const a = {
      pages: { apps: APP_IDS.slice(0, 8).map(app), entries: [entry('z')], routes: [{ path: '/b', page: lazy }] },
    };
    const b = {
      pages: { apps: APP_IDS.slice(8).map(app), entries: [entry('y')], routes: [{ path: '/a', page: lazy }] },
    };
    const one = collectPages({ '../a/pages.ts': a, '../b/pages.ts': b }, APP_IDS);
    const two = collectPages({ '../b/pages.ts': b, '../a/pages.ts': a }, APP_IDS);
    expect(two).toEqual(one);
    expect(one.menus.map((route) => route.id)).toEqual([...APP_IDS, 'y', 'z']);
    expect(one.routes.map((route) => route.path)).toEqual(['/a', '/b']);
  });
  it('注释键重复或缺导出报错，结果按键排序', () => {
    const note = { original: 'o', decision: 'd', decisions: [], level: 'L2' } as const;
    expect(() =>
      collectAnnotations({
        '../a/annotations.ts': { notes: { k: note } },
        '../b/annotations.ts': { notes: { k: note } },
      }),
    ).toThrow(/重复.*k/);
    expect(() => collectAnnotations({ '../a/annotations.ts': {} })).toThrow(/a.*notes/);
    const result = collectAnnotations({
      '../b/annotations.ts': { notes: { b: note } },
      '../a/annotations.ts': { notes: { c: note, a: note } },
    });
    expect(Object.keys(result.notes)).toEqual(['a', 'b', 'c']);
    expect(result.owners).toEqual({ a: 'a', b: 'b', c: 'a' });
  });
});

describe('AC-FE-F125-03 登记文件位置与应用内入口的菜单可见性', () => {
  it('登记文件只放在 src/<模块>/ 下，annotations 目录不再放模块注释', () => {
    const misplaced: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (['pages.ts', 'annotations.ts'].includes(name) && relative(SRC, full).split(sep).length !== 2)
          misplaced.push(relative(SRC, full));
      }
    };
    walk(SRC);
    expect(misplaced).toEqual([]);
    expect(readdirSync(join(SRC, 'annotations'))).toEqual(['index.ts']);
  });
  it('应用内入口只在所属应用入口对象含其对象时出现，排在应用之后', () => {
    const entry: EntryRoute = {
      id: 'entry',
      app: 'staff',
      label: '入口',
      group: 'people',
      objectCode: 'T.E',
      path: '/entry',
      module: 'm',
      legacy: false,
    };
    const routes = [...APP_ROUTES, entry];
    const snapshot = (entryObjects: string[]) =>
      ({ apps: [{ app: 'staff', visible: true, entryObjects }], adminMenus: [] }) as unknown as ServerSnapshot;
    expect(menuNodes(routes, snapshot(['TenantBase.Employee'])).map((menu) => menu.key)).toEqual(['staff']);
    expect(menuNodes(routes, snapshot(['T.E'])).map((menu) => menu.key)).toEqual(['staff', 'entry']);
  });
});
