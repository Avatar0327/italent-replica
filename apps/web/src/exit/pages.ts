import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m, x } from './messages.js';

// 原站在组织员工设置 > 离职退休（与“调动管理 > 调动类型”同层）；本系统没有组织员工设置菜单，
// 按 DEC-577 最保守做法挂在任职应用下、与入职管理 / Offer管理同层的独立入口；读取按任职记录查看权，入口对象同。
export const pages: ModulePages = {
  entries: [
    {
      id: 'exit-settings',
      app: 'transfer',
      label: m.settingsTitle,
      group: 'people',
      // 与 model.ts EXIT_RECORD_OBJECT 相同；Playwright 在 Node 侧加载本文件，不能经 model.ts 引入未构建的 domain。
      objectCode: 'TenantBase.EmploymentRecord',
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
