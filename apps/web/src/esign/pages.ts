import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// F-481 §8.2：「电子签」菜单组，下有 我的签署 / 签署记录 / 签署场景设置 / 设置（签署模板）；不建企业认证、员工认证、
// 印章管理（D1）。配置对象 ESignSettings 在应用目录里归企业设置应用（packages/domain app-directory.ts），菜单组跟着挂在设置下。
// 我的签署、签署记录两页（S5）的入口对象是 ESignRecord（S3b 定义），未授权时不显示。
// 对象编码与 model.ts 相同；Playwright 在 Node 侧加载本文件，不经 model.ts（不引 @italent/domain）。
const SETTINGS_OBJECT = 'TenantBase.ESignSettings';
const RECORD_OBJECT = 'TenantBase.ESignRecord';
const SELF_PATH = '/self/esign';
// §8.3：员工自助的「我的签署」与电子签下的是同一个页面、同一接口。
const MySignPage = lazyPage('MySignPage', () => import('./MySignPage.js'));
export const pages: ModulePages = {
  entries: [
    {
      id: 'esign',
      app: 'settings',
      label: '电子签',
      group: 'settings',
      children: [
        { id: 'esign-mine', label: '我的签署', objectCode: RECORD_OBJECT, page: MySignPage },
        {
          id: 'esign-records',
          label: '签署记录',
          objectCode: RECORD_OBJECT,
          page: lazyPage('RecordsPage', () => import('./RecordsPage.js')),
        },
        {
          id: 'esign-scenes',
          label: '签署场景设置',
          objectCode: SETTINGS_OBJECT,
          page: lazyPage('ScenesPage', () => import('./ScenesPage.js')),
        },
        {
          id: 'esign-templates',
          label: '设置',
          objectCode: SETTINGS_OBJECT,
          page: lazyPage('TemplatesPage', () => import('./TemplatesPage.js')),
        },
      ],
    },
  ],
  // 员工自助应用由 self-service 声明，子菜单经 menus 扩展点由本模块登记（同 idp）；可见性随员工自助，
  // 列表由后端只按本人过滤。
  menus: [
    {
      app: 'self',
      children: (_snapshot, route) => [{ key: 'self-esign', label: '我的签署', path: SELF_PATH, group: route.group }],
    },
  ],
  routes: [{ path: SELF_PATH, page: MySignPage }],
};
