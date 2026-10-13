import { m } from './messages.js';
import { object } from './model.js';
// 页面入口与后端应用目录分离；合同仍属于 staff 的授权与数据范围。
export const contractRoute = {
  id: 'contracts',
  path: '/contracts',
  label: m.title,
  group: 'people',
  objectCode: object,
} as const;
