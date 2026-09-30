import {z} from 'zod';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200);
export const qualitativeIndicator=z.object({code:z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/),title:text,category:text,description:z.string().trim().max(4000),metric:z.string().trim().max(4000),type:z.literal('qualitative')}).strict();
export const indicatorSnapshot=qualitativeIndicator.extend({id,rootId:id,version:z.number().int().positive(),orgId:id}).strict();
export type IndicatorSnapshot=z.infer<typeof indicatorSnapshot>;
export type PerformanceGoal={title:string;metric:string;weight:number;indicatorSource?:IndicatorSnapshot};
export const goalInput=z.object({title:text,metric:z.string().trim().min(5).max(4000),weight:z.number().int().min(1).max(100),indicatorId:id.optional()});
const fields={orgId:id,indicator:qualitativeIndicator};
const command=z.discriminatedUnion('action',[z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id,reason:z.string().trim().min(5).max(1500)}).strict()]);
export function applyPerformanceIndicator(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),deny=():never=>{throw new HttpError(403,'没有此组织指标维护权限');},fail=(message:string):never=>{throw new HttpError(400,message);};if(!['admin','hr'].includes(m.role))deny();
 const old=c.action==='create'?undefined:records.find(r=>r.kind==='performanceIndicator'&&r.id===c.id);if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 if(c.action==='archive'){if(old!.status==='archived')fail('指标版本已归档');return {...old!,status:'archived',updatedAt:at,payload:{...old!.payload,closedReason:c.reason}};}
 if(c.action==='seal'){if(old!.status!=='draft')fail('只有指标草稿可以定版');if(!state.orgs.some(o=>o.id===old!.payload.orgId&&o.status==='启用'))fail('指标组织已停用');return {...old!,status:'sealed',updatedAt:at};}
 if(c.action==='revise'){const family=records.filter(r=>r.kind==='performanceIndicator'&&r.payload.definitionRootId===old!.payload.definitionRootId);if(old!.status!=='sealed'||family.some(r=>r.status==='draft'||r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))fail('只能修订没有后续草稿的最新定版');return {...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...family.map(r=>r.payload.version??1))+1}};}
 if(!scopedOrgs(state,m).has(c.orgId))deny();if(!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))fail('组织不存在或已停用');if(old&&(old.status!=='draft'||old.payload.orgId!==c.orgId||old.payload.indicator?.code!==c.indicator.code))fail('只能修改同组织同编号的指标草稿');
 if(records.some(r=>r.kind==='performanceIndicator'&&r.payload.orgId===c.orgId&&r.payload.indicator?.code.toLowerCase()===c.indicator.code.toLowerCase()&&r.payload.definitionRootId!==old?.payload.definitionRootId))fail('该组织已存在此指标编号，请修订既有指标');
 const key=old?.id??crypto.randomUUID();return {id:key,kind:'performanceIndicator',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{orgId:c.orgId,indicator:c.indicator,title:c.indicator.title,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
export function resolvePerformanceGoals(input:z.infer<typeof goalInput>[],old:PerformanceGoal[]|undefined,records:R[],state:State,m:Member,orgId:string):PerformanceGoal[]{
 return input.map(({indicatorId,...goal})=>{
  if(!indicatorId)return goal;
  const retained=old?.find(g=>g.indicatorSource?.id===indicatorId)?.indicatorSource;
  if(retained)return {...goal,indicatorSource:retained};
  const r=records.find(r=>r.kind==='performanceIndicator'&&r.id===indicatorId);
  if(!r||!visibleRecord(r,records,state,m))throw new HttpError(403,'指标不存在或不可访问');
  if(r.status!=='sealed'||r.payload.orgId!==orgId)throw new HttpError(400,'新引用须选择员工同组织已定版指标');
  return {...goal,indicatorSource:indicatorSnapshot.parse({...r.payload.indicator,id:r.id,rootId:r.payload.definitionRootId,version:r.payload.version,orgId:r.payload.orgId})};
 });
}
