import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m, x } from './messages.js';

// 原站在组织员工设置 > 离职退休（与“调动管理 > 调动类型”同层）；本系统没有组织员工设置菜单，
// 按 DEC-577 最保守做法挂在企业设置应用下、与人员类别同层的独立入口（F-358）。入口对象 = 配置接口授权的任职设置对象
// （读 / 写都按企业管理员 other_settings 判定），不再额外要求任职记录查看权：没有任职权限的租户管理员也能进入并读取配置。
export const pages: ModulePages = {
  entries: [
    {
      id: 'exit-settings',
      app: 'settings',
      label: m.settingsTitle,
      group: 'settings',
      // 与 model.ts EXIT_SETTINGS_OBJECT 相同；Playwright 在 Node 侧加载本文件，不能经 model.ts 引入未构建的 domain。
      objectCode: 'TenantBase.EmploymentSettings',
      page: lazyPage('ExitSettingsPage', () => import('./ExitSettingsPage.js')),
    },
    {
      // 离职管理（FE-R2c2）：原站菜单位置未验证，同上挂在任职应用下。
      id: 'exits',
      app: 'transfer',
      label: x.title,
      group: 'people',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('ExitPage', () => import('./ExitPage.js')),
    },
  ],
};
