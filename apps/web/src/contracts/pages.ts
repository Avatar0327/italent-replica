import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
import { object } from './model.js';

// 合同是员工应用下的独立入口（DEC-482）：不新增后端应用与数据范围份额，staff 入口对象含合同对象时才显示菜单。
export const pages: ModulePages = {
  entries: [
    {
      id: 'contracts',
      app: 'staff',
      label: m.title,
      group: 'people',
      objectCode: object,
      page: lazyPage('ContractsPage', () => import('./ContractsPage.js')),
    },
  ],
};
