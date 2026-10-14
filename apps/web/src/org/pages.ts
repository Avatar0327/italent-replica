import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const OrgPage = lazyPage('OrgPage', () => import('./OrgPage.js'));
export const pages: ModulePages = {
  apps: [{ app: 'org', label: '组织管理', group: 'people', objectCode: 'TenantBase.Organization', page: OrgPage }],
  routes: [{ path: '/org/changes', page: OrgPage }],
};
