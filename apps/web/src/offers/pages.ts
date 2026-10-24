import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
// 沿用 DEC-538 入口位置；F-298 列表 / 详情读取另由 Offer 对象权限控制。
export const pages: ModulePages = {
  entries: [
    {
      id: 'offers',
      app: 'transfer',
      label: m.title,
      group: 'people',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('OffersPage', () => import('./OffersPage.js')),
    },
  ],
};
