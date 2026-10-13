import { m } from '../settings/messages.js';
/** 原站列结构；现有用户接口不提供这些字段。只保留空占位，不把合成值拼到真实用户上。 */
export const internalUserGaps = [
  { key: 'loginPhone', title: m.loginPhone, width: 120 },
  { key: 'contactPhone', title: m.contactPhone, width: 120 },
  { key: 'department', title: m.department, width: 150 },
  { key: 'job', title: m.job, width: 110 },
  { key: 'employeeCode', title: m.employeeCode, width: 110 },
  { key: 'hireDate', title: m.hireDate, width: 120 },
  { key: 'manager', title: m.manager, width: 130 },
];
export const allUserGaps = [
  { key: 'accountSource', title: m.accountSource, width: 110 },
  { key: 'createdBy', title: m.createdBy, width: 120 },
  { key: 'createdAt', title: m.createdAt, width: 170 },
];
