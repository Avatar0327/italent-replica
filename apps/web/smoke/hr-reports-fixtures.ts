/** 合成夹具形状来自 F-465a report-routes/roster-routes 和 BE-13 两类 report 路由。 */
import { PERSONNEL_REPORTS } from '../../../packages/domain/src/hr-analysis/reports.js';
export const reportCatalog = () => ({
  items: PERSONNEL_REPORTS.map(({ code, name, group, endpoint }) => ({ code, name, group, endpoint, available: true })),
});
export const reportPermission = (allowed = true) => ({
  objectCode: 'TenantBase.HrRoster',
  dataOperations: { read: true },
  viewableFields: ['asOf'],
  editableFields: [],
  buttons: allowed ? [{ buttonCode: 'export', level: 'list' }] : [],
});
export const reportPage = (code = '1.01') => ({
  asOf: '2026-10-06',
  code,
  name: PERSONNEL_REPORTS.find((r) => r.code === code)!.name,
  columns: [
    { key: 'employeeName', label: '姓名' },
    { key: 'code', label: '工号' },
  ],
  items: [{ employeeName: '合成甲', code: 'SYN-001' }],
  total: 1,
  page: 1,
  pageSize: 20,
  hasDataPermission: true,
});
export const movementPage = (code = 'monthly') => ({
  asOf: '2026-10-06',
  report: code,
  name: '各月入离职统计',
  kind: 'table',
  year: 2026,
  month: code === 'institution' ? 10 : null,
  hasDataPermission: true,
  tables: [
    {
      key: code,
      name: '入离职统计',
      columns: [
        { key: 'opening', label: '期初人数' },
        { key: 'exits', label: '离职人数' },
      ],
      rows: [
        { key: 'synthetic', label: code === 'monthly' ? '2026-01' : '合成机构', cells: { opening: 10, exits: 2 } },
      ],
      summary: { cells: { opening: 10, exits: 2 } },
    },
  ],
});
export const qualityPage = () => ({
  asOf: '2026-10-06',
  report: 'quality',
  name: '员工素质结构',
  employType: 'internal',
  hasDataPermission: true,
  columns: [
    { key: 'total', label: '合计' },
    { key: 'gender:男', label: '男' },
  ],
  rows: [
    {
      organizationId: '10000000-0000-4000-8000-000000000002',
      organizationName: '合成机构',
      cells: { total: 7, 'gender:男': 3 },
    },
  ],
  summary: { cells: { total: 7, 'gender:男': 3 } },
});
