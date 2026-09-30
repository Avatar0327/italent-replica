import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import type {Member} from './authorization';
import type {PerformanceGoal} from './performance-indicators';
import {HttpError} from './http';
export function performanceIndicatorUsage(records:R[],state:State,member:Member,indicatorId:string,page=1){
 if(!['admin','hr'].includes(member.role))throw new HttpError(403,'指标引用明细仅供管理范围内HR查看');
 const indicator=records.find(r=>r.kind==='performanceIndicator'&&r.id===indicatorId);
 if(!indicator||!visibleRecord(indicator,records,state,member))throw new HttpError(403,'指标不存在或不在管理范围');
 const rows=records.flatMap(r=>{
  if(!visibleRecord(r,records,state,member))return [];
  const kind=r.kind==='performancePlan'?'目标计划':r.kind==='performanceGoalChange'&&r.status==='submitted'?'待审调整':r.kind==='performance'&&r.status==='published'?'已发布结果':null;
  if(!kind)return [];
  const snapshot=r.payload.performanceSnapshot?.plan as {goals?:PerformanceGoal[]}|undefined;
  const goals=kind==='已发布结果'?snapshot?.goals:r.payload.goals;
  const occurrences=goals?.filter(g=>g.indicatorSource?.id===indicatorId).length??0;
  if(!occurrences)return [];
  return [{id:r.id,kind,employeeName:state.employees.find(e=>e.id===r.employeeId)?.name??'历史人员',period:r.payload.period??'',status:r.status,occurrences,updatedAt:r.updatedAt,href:kind==='待审调整'?'/performance-changes':('/performance?'+new URLSearchParams({recordId:r.id}))}];
 }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
 return {indicatorId,version:indicator.payload.version,items:rows.slice((page-1)*20,page*20),page,hasMore:rows.length>page*20,total:rows.length,counts:{plans:rows.filter(r=>r.kind==='目标计划').length,pendingChanges:rows.filter(r=>r.kind==='待审调整').length,publishedResults:rows.filter(r=>r.kind==='已发布结果').length},note:'仅统计当前授权范围、当前目标及待审调整和已发布结果快照；同记录多目标引用只计一条，不跨指标版本合并。历史事件中的已撤销引用不在本表。'};
}
