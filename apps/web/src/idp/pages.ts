import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { OWN_PLANS_PATH, TUTOR_PLANS_PATH } from './paths.js';

const IdpPage = lazyPage('IdpPage', () => import('./IdpPage.js'));
const MyPlansPage = lazyPage('MyPlansPage', () => import('./MyPlans.js'));
const TutorPlansPage = lazyPage('TutorPlansPage', () => import('./MyPlans.js'));
// 下一层三张列表按入口对象给出（原站菜单：人才发展计划 > 发展计划 / 发展计划模板 / 发展计划流程）。
const CHILDREN = [
  { object: 'IDP.Idp', key: 'plans', label: '发展计划' },
  { object: 'IDP.IDPTemplate', key: 'templates', label: '发展计划模板' },
  { object: 'IDP.IDPProcess', key: 'processes', label: '发展计划流程' },
  { object: 'IDP.Career', key: 'careers', label: '职业发展信息' },
  { object: 'IDP.WorkShift', key: 'work-shifts', label: '轮岗信息' },
];
export const pages: ModulePages = {
  entries: [
    {
      id: 'tutorship-information-group',
      app: 'idp',
      label: '带教信息',
      group: 'talent',
      children: [
        {
          id: 'tutorship-information',
          label: '带教信息',
          objectCode: 'IDP.TutorShip',
          page: lazyPage('TutorshipPage', () => import('./TutorshipPage.js')),
        },
      ],
    },
  ],
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
  // 员工自助 > 我的发展计划 > 个人发展计划 / 我辅导的发展计划（DEC-523，两项同级）；员工自助应用由 self-service 声明，
  // 子菜单经 menus 扩展点由本模块登记。可见性随员工自助，列表内容由后端按本人 / 指导人过滤（F-164）。
  menus: [
    {
      app: 'self',
      children: (_snapshot, route) => [
        {
          key: 'self-idp',
          label: '我的发展计划',
          path: OWN_PLANS_PATH,
          group: route.group,
          children: [
            { key: 'self-idp-own', label: '个人发展计划', path: OWN_PLANS_PATH, group: route.group },
            { key: 'self-idp-tutoring', label: '我辅导的发展计划', path: TUTOR_PLANS_PATH, group: route.group },
          ],
        },
      ],
    },
  ],
  routes: [
    { path: '/idp/*', page: IdpPage },
    { path: OWN_PLANS_PATH, page: MyPlansPage },
    { path: TUTOR_PLANS_PATH, page: TutorPlansPage },
  ],
};
