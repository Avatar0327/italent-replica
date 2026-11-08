import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// 原站：组织员工 → 人员信息 → 全部人员（codex-R1bd spec §2.3）。入口按任职记录对象的查看权出现（DEC-836），
// 不挂人事分析权限。不经 model.ts 引入 @italent/domain：Playwright 在 Node 侧直接加载 pages.ts（smoke/page-registry.ts）。
export const pages: ModulePages = {
  entries: [
    {
      id: 'all-people',
      app: 'transfer',
      group: 'people',
      label: '全部人员',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('AllPeoplePage', () => import('./AllPeoplePage.js')),
    },
  ],
};
