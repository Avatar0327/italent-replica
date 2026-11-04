/**
 * 人事分析路由的现状声明（F-039；BE-12a 时点员工花名册 2 条）。
 *
 * 现状链路（roster-access.ts rosterAccess，列表与导出同一份）：员工档案对象查看权 + 页面 list 范围解析（personnel.access，
 * 范围先于分页，personScope 进 WHERE，total 与本页同一谓词）→ 人事分析对象（TenantBase.HrRoster）查看权，导出另须列表级
 * “导出”按钮 → 逐列字段权：人员 / 任职记录 / 合同三个对象各取可见字段（任职、合同另须对象查看权），无权的整列缺席，
 * 导出表头与列表 columns 是同一份可见列；筛选字段无查看权 403（守卫 hrAnalysis.rosterFilters）。
 */
import { MODULE_OBJECTS, PERSONNEL_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  all,
  button,
  listScope,
  member,
  noButton,
  noFields,
  noScope,
  object,
  projector,
} from '../../route-policy/presets.js';
import { ROSTER_OBJECT } from './roster-access.js';

const BASE = '/api/tenant/hr-analysis/roster';
const projection = projector('hrAnalysis.roster', 'hrAnalysis.roster');

/**
 * 任职记录 / 合同对象的查看权不拒绝请求，只决定对应的列是否出现（披露分支，同 personnel 的 nestedSubsets）；
 * 字段权随其后的可见字段集合逐列裁剪。分支的行范围就是员工档案对象解析出的同一个范围。
 */
const columnBranch = (code: string) =>
  object({
    object: code,
    operation: 'view',
    button: noButton('列只按对象查看权与字段权出现，无按钮'),
    scope: listScope('personnel.personScope'),
    fields: projection,
  });
const optional = {
  recordColumns: columnBranch(MODULE_OBJECTS.employmentRecord.code),
  contractColumns: columnBranch(MODULE_OBJECTS.contract.code),
};

/** 员工档案对象：查看权 + 数据范围（复用 personnel 列表的 personScope，AC-HA-05）。 */
const person = object({
  object: PERSONNEL_OBJECT,
  operation: 'view',
  button: noButton('时点名册只按对象查看权（页面 list），无按钮'),
  scope: listScope('personnel.personScope'),
  fields: projection,
});
const rosterView = (exporting: boolean) =>
  object({
    object: ROSTER_OBJECT,
    operation: 'view',
    button: exporting ? button('export', 'list') : noButton('列表只按人事分析对象查看权，无按钮'),
    scope: noScope('人事分析对象无组织字段；数据范围由员工档案对象解析，字段权按列逐对象裁剪'),
    fields: projection,
  });

const REPORTS = '/api/tenant/hr-analysis/reports';
/**
 * 目录可用性（availability）逐个对象问一次查看权，只把结果标进目录条目，不拒绝请求、不返回业务数据：
 * 披露分支按对象各一个，行范围与字段都不适用（目录只含元数据）。
 */
const availabilityBranch = (code: string) =>
  object({
    object: code,
    operation: 'view',
    button: noButton('目录只标注可用性，无按钮'),
    scope: noScope('目录元数据不含人员数据，无范围'),
    fields: noFields('目录元数据，不是业务字段'),
  });
export const AVAILABILITY_OBJECTS = {
  availPerson: PERSONNEL_OBJECT,
  availRoster: MODULE_OBJECTS.hrRoster.code,
  availRecord: MODULE_OBJECTS.employmentRecord.code,
  availContract: MODULE_OBJECTS.contract.code,
  availMovement: MODULE_OBJECTS.hrMovementReport.code,
  availStructure: MODULE_OBJECTS.hrStructureReport.code,
} as const;
const availability = Object.fromEntries(
  Object.entries(AVAILABILITY_OBJECTS).map(([name, code]) => [name, availabilityBranch(code)]),
);
const REPORT_GUARD = 'hrAnalysis.reportObjects';
const reportsProjection = projector('hrAnalysis.reports', 'hrAnalysis.reports');

export const HR_ANALYSIS_POLICIES = defineTable('hr-analysis', {
  // F-465a 报表目录：只返回报表元数据与按各自对象查看权算出的可用性，不含业务数据
  [`GET ${REPORTS}`]: member('报表目录只含元数据，可用性按调用方对象查看权标注', noFields('目录元数据，不是业务字段'), {
    optional: availability,
  }),
  // 8 张报表同一条权限链：花名册同款（员工档案范围 + 人事分析对象 + 导出按钮）；1.06 / 1.07 / 1.1.01 / 1.1.02 另须
  // 合同 / 任职记录对象查看权，缺失 403——由具名守卫 hrAnalysis.reportObjects（report-routes.ts requireReportObjects）
  // 强制，required 表登记其调用与拒绝语义；optional 里的两个分支仍只是花名册式的列披露，不承担这个准入
  [`GET ${REPORTS}/:code`]: all([person, rosterView(false)], reportsProjection, { optional, guards: [REPORT_GUARD] }),
  [`GET ${REPORTS}/:code/export`]: all([person, rosterView(true)], reportsProjection, {
    optional,
    guards: [REPORT_GUARD],
  }),
  [`GET ${BASE}`]: all([person, rosterView(false)], projection, { optional }),
  [`GET ${BASE}/export`]: all([person, rosterView(true)], projection, { optional }),
});
