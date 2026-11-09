/**
 * F-474-4c：GET /api/tenant/employment/all-people 的真实响应形状（一行 + 列定义）。
 * 后端验收（AC-EMP-F474-4c-all-people）断言真实响应的键集与列顺序和本样例一致；前端渲染测试
 * （AC-EMP-F474-4c-all-people-ui）用它当接口夹具，避免前端夹具自己编形状。
 */
export const ALL_PEOPLE_COLUMNS = [
  { key: 'employeeName', label: '姓名' },
  { key: 'email', label: '邮箱' },
  { key: 'code', label: '工号' },
  { key: 'orgLevel1', label: '一级组织' },
  { key: 'orgLevel2', label: '二级组织' },
  { key: 'orgLevel3', label: '三级组织' },
  { key: 'departmentName', label: '部门' },
  { key: 'level', label: '职级' },
  { key: 'positionName', label: '职位' },
  { key: 'directManagerName', label: '直线经理' },
  { key: 'entryDate', label: '入职日期' },
  { key: 'companyTenureYears', label: '司龄' },
  { key: 'gender', label: '性别' },
  { key: 'idType', label: '证件类型' },
  { key: 'idNumber', label: '证件号码' },
  { key: 'age', label: '年龄' },
] as const;

export const ALL_PEOPLE_ROW = {
  employeeId: '30000000-0000-4000-8000-0000000004c1',
  employeeName: '合成员工甲',
  email: 'syn4c1@example.com',
  code: 'SYN-4C-1',
  orgLevel1: '合成集团',
  orgLevel2: '合成研发部',
  orgLevel3: '合成后端组',
  departmentName: '合成后端组',
  level: '合成职级一',
  positionName: '合成后端工程师',
  directManagerName: '合成经理乙',
  entryDate: '2025-07-01',
  companyTenureYears: '1.2',
  gender: '男',
  idType: '合成证件类型',
  idNumber: 'SYN-ID-0001',
  age: 36,
};

export const ALL_PEOPLE_PAGE = {
  asOf: '2026-10-06',
  items: [ALL_PEOPLE_ROW],
  columns: ALL_PEOPLE_COLUMNS,
  total: 1,
  page: 1,
  pageSize: 15,
  hasDataPermission: true,
};
