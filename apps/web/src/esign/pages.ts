import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// F-481 §8.2：「电子签」菜单组，下有 我的签署 / 签署记录 / 签署场景设置 / 设置（签署模板）；不建企业认证、员工认证、
// 印章管理（D1）。配置对象 ESignSettings 在应用目录里归企业设置应用（packages/domain app-directory.ts），菜单组跟着挂在设置下。
// 我的签署、签署记录两页属 S5：本片只登记菜单位置，不挂页面；入口对象 ESignRecord 由 S3b 定义，未授权时不显示。
// 对象编码与 model.ts 相同；Playwright 在 Node 侧加载本文件，不经 model.ts（不引 @italent/domain）。
const SETTINGS_OBJECT = 'TenantBase.ESignSettings';
const RECORD_OBJECT = 'TenantBase.ESignRecord';
export const pages: ModulePages = {
  entries: [
    {
      id: 'esign',
      app: 'settings',
      label: '电子签',
      group: 'settings',
      children: [
        { id: 'esign-mine', label: '我的签署', objectCode: RECORD_OBJECT },
        { id: 'esign-records', label: '签署记录', objectCode: RECORD_OBJECT },
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
};
