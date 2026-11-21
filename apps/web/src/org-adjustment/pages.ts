import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { text } from './messages.js';
import { approvalPath, path } from './model.js';

export const pages: ModulePages = {
  menus: [
    {
      app: 'org',
      // 菜单沿用组织管理的快照入口；申请单的读取和写入仍按各自的服务端对象及范围判定。
      children: (_snapshot, route) => [{ key: 'org-adjustments', label: text.title, path, group: route.group }],
    },
  ],
  routes: [
    {
      path,
      page: lazyPage('AdjustmentPage', () => import('./AdjustmentPage.js')),
    },
    {
      // 待办参与者可从审批应用直达原单；详情接口继续按申请单范围或审批关系鉴权。
      path: approvalPath,
      page: lazyPage('ApprovalAdjustmentPage', () => import('./AdjustmentPage.js')),
    },
  ],
};
