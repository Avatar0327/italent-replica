import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
import { s } from './settings-messages.js';
export const pages: ModulePages = {
  entries: [
    {
      id: 'probations',
      app: 'transfer',
      group: 'people',
      label: m.title,
      // 不经 model.ts 引入 @italent/domain：Playwright 在 Node 侧直接加载 pages.ts（smoke/page-registry.ts）
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('ProbationPage', () => import('./ProbationPage.js')),
    },
    {
      // FE-R2c1b：字典与规则读取按任职记录对象授权，写入另按任职设置对象 + 其他设置菜单判定（settings-model.ts）。
      id: 'probation-settings',
      app: 'transfer',
      group: 'people',
      label: s.title,
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('ProbationSettingsPage', () => import('./ProbationSettingsPage.js')),
    },
  ],
};
