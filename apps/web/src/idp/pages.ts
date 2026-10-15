import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const IdpPage = lazyPage('IdpPage', () => import('./IdpPage.js'));
const MyPlansPage = lazyPage('MyPlansPage', () => import('./MyPlans.js'));
const TutorPlansPage = lazyPage('TutorPlansPage', () => import('./MyPlans.js'));
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
    // 员工自助 > 我的发展计划 > 个人发展计划 / 我辅导的发展计划：员工自助左侧菜单只能由员工自助登记
    // （page-registry 规定子项由声明该应用的模块提供），本片只提供路由，两页之间用页内同级导航切换。
    { path: '/self/idp', page: MyPlansPage },
    { path: '/self/idp/tutoring', page: TutorPlansPage },
  ],
};
