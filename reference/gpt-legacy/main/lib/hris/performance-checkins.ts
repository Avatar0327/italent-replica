import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,isTalentManager,orgWithin,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(4000);
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('submit'),id:id.optional(),planId:id,goalIndex:z.number().int().min(0).max(19),progress:z.number().int().min(0).max(100),evidence,actionPlan:evidence}),
 z.object({action:z.literal('feedback'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence})
]);
/** Check-ins are employee-reported evidence, never a score or a completion gate. */
export function applyPerformanceCheckin(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const live=(p:R)=>{const e=state.employees.find(e=>e.id===p.employeeId),cy=get(p.referenceId!,'performanceCycle');if(!e||e.status==='离职'||cy.status!=='active'||!orgWithin(state,e.orgId,cy.payload.orgId!)||p.status!=='confirmed'||records.some(r=>r.kind==='performance'&&r.payload.sourcePlanId===p.id))fail('仅当前周期组织范围内的在职员工、活动周期内的已确认待自评计划可继续跟进');};
 if(c.action==='submit'){
  const p=get(c.planId,'performancePlan');if(p.employeeId!==member.employeeId)deny('仅员工本人可提交目标执行记录');live(p);if(records.some(r=>r.kind==='performanceGoalChange'&&r.referenceId===p.id&&r.status==='submitted'))fail('请先处理或撤回待审目标调整');const g=p.payload.goals?.[c.goalIndex];if(!g)fail('目标序号无效');const old=c.id?get(c.id,'performanceCheckin'):undefined;
  if(old&&(old.createdBy!==member.userId||old.employeeId!==member.employeeId||old.referenceId!==p.id))deny('只能补充本人原计划的跟进记录');if(old&&(old.status!=='returned'||old.payload.basePlanVersion!==(p.payload.version??1)||JSON.stringify(old.payload.checkinGoal)!==JSON.stringify(g)||old.payload.goalIndex!==c.goalIndex))fail('仅同一目标版本的退回记录可以补充；目标已调整时请新建跟进');
  if(records.some(r=>r.kind==='performanceCheckin'&&r.referenceId===p.id&&r.payload.basePlanVersion===(p.payload.version??1)&&r.payload.goalIndex===c.goalIndex&&r.status==='submitted'&&r.id!==old?.id))fail('此目标已有待反馈记录');
  return {id:old?.id??crypto.randomUUID(),kind:'performanceCheckin',employeeId:p.employeeId,positionId:null,referenceId:p.id,status:'submitted',createdBy:old?.createdBy??member.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{period:p.payload.period,basePlanVersion:p.payload.version??1,goalIndex:c.goalIndex,checkinGoal:{...g!},progressPercent:c.progress,evidence:c.evidence,actionPlan:c.actionPlan,submittedBy:member.userId,submittedAt:at}};
 }
 const r=get(c.id,'performanceCheckin');const change=(status:string,payload:R['payload']):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='withdraw'){if(r.createdBy!==member.userId||r.employeeId!==member.employeeId)deny('仅记录本人可撤回');if(!['submitted','returned'].includes(r.status))fail('已反馈或撤回的记录不可再撤回');return change('withdrawn',{closedReason:c.evidence});}
 const e=state.employees.find(e=>e.id===r.employeeId);if(!isTalentManager(member)||!e||!scopedOrgs(state,member).has(e.orgId)||r.employeeId===member.employeeId||r.createdBy===member.userId)deny('须由有权限的其他管理者提供反馈');if(r.status!=='submitted')fail('记录不是待反馈状态');live(get(r.referenceId!,'performancePlan'));
 return change(c.accepted?'acknowledged':'returned',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});
}
