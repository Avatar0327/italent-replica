import { m } from '../settings/messages.js';
/** 原站列结构；现有用户接口不提供这些字段。只保留空占位，不把合成值拼到真实用户上。 */
export const internalUserGaps = [
  { key: 'loginPhone', title: m.loginPhone, width: 128 },
  { key: 'contactPhone', title: m.contactPhone, width: 128 },
  { key: 'department', title: m.department, width: 128 },
  { key: 'job', title: m.job, width: 128 },
  { key: 'employeeCode', title: m.employeeCode, width: 128 },
  { key: 'hireDate', title: m.hireDate, width: 93 },
  { key: 'manager', title: m.manager, width: 118 },
];
export const allUserGaps = [
  { key: 'accountSource', title: m.accountSource, width: 128 },
  { key: 'createdBy', title: m.createdBy, width: 118 },
  { key: 'createdAt', title: m.createdAt, width: 146 },
];
