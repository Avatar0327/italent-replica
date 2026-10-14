import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const IdpPage = lazyPage('IdpPage', () => import('./IdpPage.js'));
const MyPlansPage = lazyPage('MyPlansPage', () => import('./MyPlans.js'));
// 下一层三张列表按入口对象给出（原站菜单：人才发展计划 > 发展计划 / 发展计划模板 / 发展计划流程）。
const CHILDREN = [
  { object: 'IDP.Idp', key: 'plans', label: '发展计划' },
  { object: 'IDP.IDPTemplate', key: 'templates', label: '发展计划模板' },
  { object: 'IDP.IDPProcess', key: 'processes', label: '发展计划流程' },
];
export const pages: ModulePages = {
  apps: [
    {
      app: 'idp',
      label: '人才发展计划',
      group: 'talent',
      objectCode: 'IDP.IDPTemplate',
      page: IdpPage,
      children: (snapshot, route) => {
        const entries = snapshot.apps.find((app) => app.app === 'idp')?.entryObjects ?? [];
        return CHILDREN.filter((child) => entries.includes(child.object)).map((child) => ({
          key: `idp-${child.key}`,
          label: child.label,
          path: `/idp/${child.key}`,
          group: route.group,
        }));
      },
    },
  ],
  routes: [
    { path: '/idp/*', page: IdpPage },
    // 员工自助 > 我的发展计划：菜单项需在员工自助登记（归属外），本片只提供路由。
    { path: '/self/idp', page: MyPlansPage },
  ],
};
