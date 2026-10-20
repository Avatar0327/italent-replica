/**
 * 人事分析路由的现状声明（F-039；BE-12a 时点员工花名册 2 条）。
 *
 * 现状链路（roster-access.ts rosterAccess，列表与导出同一份）：员工档案对象查看权 + 页面 list 范围解析（personnel.access，
 * 范围先于分页，personScope 进 WHERE，total 与本页同一谓词）→ 人事分析对象（TenantBase.HrRoster）查看权，导出另须列表级
 * “导出”按钮 → 逐列字段权：人员 / 任职记录 / 合同三个对象各取可见字段（任职、合同另须对象查看权），无权的整列缺席，
 * 导出表头与列表 columns 是同一份可见列；筛选字段无查看权 403（守卫 hrAnalysis.rosterFilters）。
 */
import { PERSONNEL_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import { all, button, listScope, noButton, noScope, object, projector } from '../../route-policy/presets.js';
import { ROSTER_OBJECT } from './roster-access.js';

const BASE = '/api/tenant/hr-analysis/roster';
const projection = projector('hrAnalysis.roster', 'hrAnalysis.roster');
const guards = ['hrAnalysis.rosterColumns', 'hrAnalysis.rosterFilters'];

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

export const HR_ANALYSIS_POLICIES = defineTable('hr-analysis', {
  [`GET ${BASE}`]: all([person, rosterView(false)], projection, { guards }),
  [`GET ${BASE}/export`]: all([person, rosterView(true)], projection, { guards }),
});
