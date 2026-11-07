import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// 原站：组织员工 → 任职管理 → 任职记录（codex-R1bd spec §2.4）。入口按任职记录对象的查看权出现。
// 不经 model.ts 引入 @italent/domain：Playwright 在 Node 侧直接加载 pages.ts（smoke/page-registry.ts）。
export const pages: ModulePages = {
  entries: [
    {
      id: 'employment-records',
      app: 'transfer',
      group: 'people',
      label: '任职记录',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('EmploymentRecordsPage', () => import('./EmploymentRecordsPage.js')),
    },
  ],
};
