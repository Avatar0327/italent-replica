import type { ModulePages } from '../foundation/page-registry.js';

// 页面片未接入前显示空首页；接入时在本文件补 page。
export const pages: ModulePages = {
  apps: [{ app: 'qualification', label: '任职资格', group: 'talent', objectCode: 'Qualification.EmploymentCategory' }],
};
