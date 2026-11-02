import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// 原站在 设置 › 员工 › 人员类别（docs/02_业务建模/17 §F-323）；本系统挂在企业设置应用下，入口对象为人员类别。
export const pages: ModulePages = {
  entries: [
    {
      id: 'employment-types',
      app: 'settings',
      label: '人员类别',
      group: 'settings',
      // 与 model.ts EMPLOYMENT_TYPE_OBJECT 相同；Playwright 在 Node 侧加载本文件，不经 model.ts。
      objectCode: 'TenantBase.EmploymentType',
      page: lazyPage('EmploymentTypesPage', () => import('./EmploymentTypesPage.js')),
    },
  ],
};
