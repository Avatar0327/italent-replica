/**
 * 人事报表目录与名册分析报表的列定义（docs/02_业务建模/35 §2.1 预置报表；F-465a、DEC-763①）。
 * 12 张预置报表：员工名册分析 8 张（本文件定义其中 1.06 / 1.07 / 1.1.02 的专用列，其余沿用花名册列）、
 * 人事报表 3 张与员工花名册（沿用既有接口，目录只引用）。每列声明受哪个对象的哪个字段权约束，列表与导出共用。
 */
import type { RosterColumn } from './roster.js';

export type ReportGroup = '员工名册分析' | '人事报表' | '员工花名册';
/** 目录条目依赖的“人事分析”权限对象（MODULE_OBJECTS 的键）。 */
export type ReportPermission = 'hrRoster' | 'hrMovementReport' | 'hrStructureReport';

export interface PersonnelReport {
  readonly code: string;
  readonly name: string;
  readonly group: ReportGroup;
  readonly endpoint: string;
  readonly permission: ReportPermission;
  /** 除花名册查看权与员工档案范围外，另须查看权的对象（缺失 → 403；比花名册“缺列”更保守）。 */
  readonly requires: readonly ('record' | 'contract')[];
}

const BASE = '/api/tenant/hr-analysis/reports';
const analysis = (code: string, name: string, requires: PersonnelReport['requires'] = []): PersonnelReport => ({
  code,
  name,
  group: '员工名册分析',
  endpoint: `${BASE}/${code}`,
  permission: 'hrRoster',
  requires,
});

/** 目录顺序 = 页面展示顺序。 */
export const PERSONNEL_REPORTS: readonly PersonnelReport[] = [
  analysis('1.01', '在职员工花名册'),
  analysis('1.04', '实习人员花名册'),
  analysis('1.05', '外部人员花名册'),
  analysis('1.06', '合同（协议）台账', ['contract']),
  analysis('1.07', '异动人员明细', ['record']),
  analysis('1.08', '在职全部人员明细'),
  analysis('1.1.01', '全部员工名册', ['record']),
  analysis('1.1.02', '员工任职信息', ['record']),
  {
    code: 'roster',
    name: '员工花名册',
    group: '员工花名册',
    permission: 'hrRoster',
    requires: [],
    endpoint: '/api/tenant/hr-analysis/roster',
  },
  {
    code: 'monthly',
    name: '各月入离职统计',
    group: '人事报表',
    permission: 'hrMovementReport',
    requires: [],
    endpoint: '/api/tenant/analytics/hr-movement/reports/monthly',
  },
  {
    code: 'institution',
    name: '各机构入离职统计',
    group: '人事报表',
    permission: 'hrMovementReport',
    requires: [],
    endpoint: '/api/tenant/analytics/hr-movement/reports/institution',
  },
  {
    code: 'quality',
    name: '员工素质结构统计',
    group: '人事报表',
    permission: 'hrStructureReport',
    requires: [],
    endpoint: '/api/tenant/analytics/hr-structure/reports/quality',
  },
];

/** 8 张新报表的编码（花名册类 5 张沿用 roster-query，另 3 张有专用查询）。 */
export const ROSTER_BASED_REPORTS = ['1.01', '1.04', '1.05', '1.08', '1.1.01'] as const;
export type RosterBasedReport = (typeof ROSTER_BASED_REPORTS)[number];
export const DEDICATED_REPORTS = ['1.06', '1.07', '1.1.02'] as const;
export type DedicatedReport = (typeof DEDICATED_REPORTS)[number];

const col = (source: 'person' | 'record' | 'contract', key: string, label: string, field = key): RosterColumn => ({
  key,
  label,
  gate: [[source, field]],
});
const FIXED: readonly RosterColumn[] = [col('person', 'employeeName', '姓名', 'name'), col('person', 'code', '工号')];

/** 1.06 合同（协议）台账：一行 = 一次签订 / 续签产生的合同。 */
export const CONTRACT_LEDGER_COLUMNS: readonly RosterColumn[] = [
  ...FIXED,
  col('contract', 'number', '合同编号'),
  col('contract', 'typeName', '合同类型', 'typeId'),
  col('contract', 'companyName', '合同主体', 'companyId'),
  col('contract', 'operation', '操作类型', 'typeId'),
  col('contract', 'termType', '合同期限类型'),
  col('contract', 'termMonths', '合同期限（月）'),
  col('contract', 'signingDate', '签订日期'),
  col('contract', 'effectiveDate', '合同生效日期'),
  col('contract', 'endDate', '合同终止日期'),
  col('contract', 'actualTerminationDate', '实际终止时间'),
];

/** 1.07 异动人员明细：一行 = 一次入职 / 转正 / 调动 / 离职；不建“变更前”列（版本链上一条即是）。 */
export const MOVEMENT_DETAIL_COLUMNS: readonly RosterColumn[] = [
  ...FIXED,
  col('record', 'category', '异动类别', 'kind'),
  col('record', 'date', '异动日期', 'effectiveDate'),
  col('record', 'orgFullName', '组织全称', 'departmentId'),
  col('record', 'employType', '雇佣关系'),
];

/** 1.1.02 员工任职信息：一行 = 一条任职记录（含兼职）。 */
export const EMPLOYMENT_HISTORY_COLUMNS: readonly RosterColumn[] = [
  ...FIXED,
  col('record', 'serviceType', '任职类型', 'kind'),
  col('record', 'kind', '业务类型'),
  col('record', 'startDate', '开始日期', 'effectiveDate'),
  col('record', 'endDate', '结束日期', 'effectiveDate'),
  col('record', 'orgFullName', '组织全称', 'departmentId'),
  col('record', 'employType', '雇佣关系'),
];

/** 异动类别（1.07）。离职类含退休，与人事看板“离职”同口径。 */
export const MOVEMENT_CATEGORIES = ['entry', 'regularization', 'transfer', 'leave'] as const;
export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

const CELL_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: { entry: '入职', regularization: '转正', transfer: '调动', leave: '离职' },
  operation: { create: '签订', renew: '续签' },
  serviceType: { primary: '主职', part_time: '兼职' },
  kind: {
    hire: '入职',
    rehire: '重聘',
    retire_rehire: '退休返聘',
    regularization: '转正',
    transfer: '调动',
    org_adjustment: '组织调整',
    leave: '离职',
    retirement: '退休',
    intern_regularization: '实习转正',
    part_time: '兼职',
  },
  employType: { internal: '内部员工', intern: '实习生', external: '外部人员' },
};

/** 报表导出单元格里的码值转中文（花名册类的列沿用 rosterCellText）。 */
export function reportCellLabel(key: string, value: unknown): string | undefined {
  return typeof value === 'string' ? CELL_LABELS[key]?.[value] : undefined;
}
