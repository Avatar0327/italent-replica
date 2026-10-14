import type { ModulePages } from '../foundation/page-registry.js';

// 页面片未接入前显示空首页；接入时在本文件补 page。
export const pages: ModulePages = {
  apps: [{ app: 'succession', label: '继任管理', group: 'talent', objectCode: 'Succession.Map' }],
};
