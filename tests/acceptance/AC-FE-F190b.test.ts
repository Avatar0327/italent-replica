import { describe, expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { mountPath, pageRoutes } from '../../apps/web/src/foundation/page-registry.js';
import { MENU_ROUTES, PAGES, appRoute } from '../../apps/web/src/foundation/routes.js';

const snapshot = (entryObjects: string[], visible = true) =>
  ({ apps: [{ app: 'idp', visible, entryObjects }] }) as ServerSnapshot;
const tutor = { key: 'tutorship-information', label: '带教信息', path: '/tutorship-information', group: 'talent' };

describe('AC-FE-F190b 带教入口层级', () => {
  it('01 带教信息分组下只有同名子项，子项沿用原路径', () => {
    expect(menuNodes(PAGES.entries, snapshot(['IDP.TutorShip']))).toEqual([
      { ...tutor, key: 'tutorship-information-group', directory: true, children: [tutor] },
    ]);
  });
  it('02 无带教入口对象或应用不可见时隐藏整组', () => {
    expect(menuNodes(PAGES.entries, snapshot(['IDP.Career']))).toEqual([]);
    expect(menuNodes(PAGES.entries, snapshot(['IDP.TutorShip'], false))).toEqual([]);
  });
  it('03 深链仍挂原带教页面，分组不挂路由', () => {
    const route = appRoute('/tutorship-information');
    expect(route).toMatchObject({ id: tutor.key, objectCode: 'IDP.TutorShip', page: { name: 'TutorshipPage' } });
    expect(appRoute('/tutorship-information/detail')).toBe(route);
    expect(mountPath(route!)).toBe('/tutorship-information/*');
    expect(pageRoutes(PAGES.entries).some((item) => item.id === 'tutorship-information-group')).toBe(false);
  });
  it('04 人才发展计划和员工自助的菜单结构、顺序保持不变', () => {
    const response = snapshot(['IDP.Idp', 'IDP.IDPTemplate', 'IDP.IDPProcess', 'IDP.Career', 'IDP.WorkShift']);
    expect(menuNodes(MENU_ROUTES, response)).toEqual([
      {
        key: 'idp',
        label: '人才发展计划',
        path: '/idp',
        group: 'talent',
        children: [
          ['plans', '发展计划'],
          ['templates', '发展计划模板'],
          ['processes', '发展计划流程'],
          ['careers', '职业发展信息'],
          ['work-shifts', '轮岗信息'],
        ].map(([key, label]) => ({ key: `idp-${key}`, label, path: `/idp/${key}`, group: 'talent' })),
      },
    ]);
    const self = menuNodes(MENU_ROUTES, { apps: [{ app: 'self', visible: true, entryObjects: [] }] } as ServerSnapshot);
    expect(self[0]?.children?.find((item) => item.key === 'self-idp')).toEqual({
      key: 'self-idp',
      label: '我的发展计划',
      path: '/self/idp',
      group: 'work',
      children: [
        { key: 'self-idp-own', label: '个人发展计划', path: '/self/idp', group: 'work' },
        { key: 'self-idp-tutoring', label: '我辅导的发展计划', path: '/self/idp/tutoring', group: 'work' },
      ],
    });
  });
});
