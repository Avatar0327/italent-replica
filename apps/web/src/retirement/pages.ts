import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
export const pages: ModulePages = {
  entries: [
    {
      id: 'retirements',
      app: 'transfer',
      group: 'people',
      label: m.title,
      // 不经 model.ts 引入 @italent/domain：Playwright 在 Node 侧直接加载 pages.ts（smoke/page-registry.ts）
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('RetirementPage', () => import('./RetirementPage.js')),
    },
  ],
};
