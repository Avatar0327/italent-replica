import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const SelfPage = lazyPage('SelfPage', () => import('./pages/SelfPage.js'));
const ManagerPage = lazyPage('ManagerPage', () => import('./pages/ManagerPage.js'));
export const pages: ModulePages = {
  apps: [
    { app: 'self', label: '员工自助', group: 'work', page: SelfPage },
    { app: 'manager', label: '管理者工作台', group: 'work', page: ManagerPage },
  ],
  routes: [
    { path: '/self/*', page: SelfPage },
    { path: '/manager/*', page: ManagerPage },
  ],
};
