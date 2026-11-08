/**
 * F-474-4b #16：GET /api/tenant/employment/records 一行的真实响应形状。
 * 后端验收（AC-EMP-F474-4b-records-list）断言真实响应的键集与本样例一致；前端渲染测试（AC-EMP-F474-4b-records-ui）
 * 用本样例当接口夹具，避免前端夹具自己编形状。
 */
export const RECORD_ROW = {
  id: '30000000-0000-4000-8000-0000000004b1',
  employeeId: '30000000-0000-4000-8000-0000000004b2',
  serviceType: 'primary',
  employeeCode: 'SYN-4B-1',
  employeeName: '合成员工甲',
  kind: 'transfer',
  effectiveDate: '2026-03-01',
  stopDate: null,
  isCurrent: true,
  fields: {
    departmentId: '30000000-0000-4000-8000-0000000004b3',
    employmentType: null,
    employType: null,
    jobNumber: null,
  },
  orgCode: 'SYN_ORG_4B',
  orgFullName: '合成租户/合成集团/合成销售部',
  departmentName: '合成销售部',
  orgLevels: ['合成集团', '合成销售部', null],
};
