import type { ModulePages } from '../foundation/page-registry.js';

// 页面片未接入前显示空首页；接入时在本文件补 page。
export const pages: ModulePages = {
  apps: [{ app: 'idp', label: '个人发展计划', group: 'talent', objectCode: 'IDP.IDPTemplate' }],
};
