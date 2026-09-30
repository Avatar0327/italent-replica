import {goalInput,resolvePerformanceGoals} from './performance-indicators';
import {validatePerformanceGoalRules} from './performance-templates';
import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,isTalentManager,orgWithin,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(4000),goal=goalInput;
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('request'),planId:id,goals:z.array(goal).min(1).max(20),evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),z.object({action:z.literal('withdraw'),id,evidence})
]);
export function applyPerformanceChange(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=command.parse(input),scope=scopedOrgs(state,member),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const live=(p:R)=>{const cycle=get(p.referenceId!,'performanceCycle'),e=state.employees.find(e=>e.id===p.employeeId);if(cycle.status!=='active'||p.status!=='confirmed'||!e||e.status==='离职'||!orgWithin(state,e.orgId,cycle.payload.orgId!)||records.some(r=>r.kind==='performance'&&r.payload.sourcePlanId===p.id))fail('仅当前周期组织范围内的在职员工、活动周期内且尚未提交自评的已确认目标可以调整');};
 if(c.action==='request'){
  const p=get(c.planId,'performancePlan'),e=state.employees.find(e=>e.id===p.employeeId);if(!e||!(e.id===member.employeeId||isTalentManager(member)&&scope.has(e.orgId)))deny('没有此员工目标的调整权限');live(p);validatePerformanceGoalRules(get(p.referenceId!,'performanceCycle').payload.performanceTemplate,c.goals);if(c.goals.reduce((sum,g)=>sum+g.weight,0)!==100)fail('调整后目标权重合计须为100%');const resolvedGoals=resolvePerformanceGoals(c.goals,p.payload.goals,records,state,member,e!.orgId);if(JSON.stringify(resolvedGoals)===JSON.stringify(p.payload.goals))fail('目标未发生改变');if(records.some(r=>r.kind==='performanceGoalChange'&&r.referenceId===p.id&&r.status==='submitted'))fail('本计划已有待复核的目标调整');
  return [{id:crypto.randomUUID(),kind:'performanceGoalChange',employeeId:p.employeeId,positionId:null,referenceId:p.id,status:'submitted',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{period:p.payload.period,goals:resolvedGoals,originalGoals:p.payload.goals,basePlanVersion:p.payload.version??1,basePlanUpdatedAt:p.updatedAt,evidence:c.evidence}}];
 }
 const r=get(c.id,'performanceGoalChange');if(r.status!=='submitted')fail('目标调整已经处理');const changed=(status:string,payload:R['payload']={}):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='withdraw'){if(r.createdBy!==member.userId)deny('仅申请人可撤回目标调整');return [changed('withdrawn',{closedReason:c.evidence})];}
 const e=state.employees.find(e=>e.id===r.employeeId);if(!isTalentManager(member)||!e||!scope.has(e.orgId)||r.employeeId===member.employeeId||r.createdBy===member.userId)deny('须由非本人、非申请人的其他有权限管理者复核');
 if(!c.accepted)return [changed('rejected',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at})];const p=get(r.referenceId!,'performancePlan');live(p);validatePerformanceGoalRules(get(p.referenceId!,'performanceCycle').payload.performanceTemplate,r.payload.goals!);
 if((p.payload.version??1)!==r.payload.basePlanVersion||p.updatedAt!==r.payload.basePlanUpdatedAt||JSON.stringify(p.payload.goals)!==JSON.stringify(r.payload.originalGoals))fail('计划已变化，请重新核对并提交调整');
 return [changed('approved',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at}),{...p,updatedAt:at,payload:{...p.payload,goals:r.payload.goals,version:(p.payload.version??1)+1,goalChangeId:r.id,confirmedBy:member.userId,confirmedAt:at,selfResponses:undefined,evaluationResponses:undefined,selfEvidence:undefined,selfReviewedAt:undefined,scores:undefined,score:undefined,evaluation:undefined,evaluatedBy:undefined,evaluatedAt:undefined,verification:undefined}}];
}
