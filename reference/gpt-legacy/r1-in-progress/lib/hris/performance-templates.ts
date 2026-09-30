import {z} from 'zod';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),title=z.string().trim().min(1).max(100);
export const performancePrompt=z.object({id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/),title,stage:z.enum(['selfReview','evaluation']),required:z.boolean()}).strict();
const prompts=z.array(performancePrompt).max(10).refine(v=>new Set(v.map(p=>p.id)).size===v.length,'文本项ID不能重复');
export const performanceGoalRules=z.object({minCount:z.number().int().min(1).max(20),maxCount:z.number().int().min(1).max(20),minWeight:z.number().int().min(1).max(100),maxWeight:z.number().int().min(1).max(100),enforceCount:z.boolean().optional(),enforceWeight:z.boolean().optional()}).strict().refine(r=>r.minCount<=r.maxCount&&r.minWeight<=r.maxWeight,'目标数量或权重范围无效').refine(r=>Array.from({length:20},(_,i)=>i+1).some(n=>(r.enforceCount===false||n>=r.minCount&&n<=r.maxCount)&&(r.enforceWeight===false||n*r.minWeight<=100&&n*r.maxWeight>=100)),'此数量和权重组合无法达到总权重100%');
export const performanceTemplateSnapshot=z.object({id,rootId:id,version:z.number().int().positive(),title,description:z.string().max(200),orgId:id,workflow:z.literal('single-weighted-goals-v1'),prompts,goalRules:performanceGoalRules.optional()}).strict();
export type PerformanceTemplateSnapshot=z.infer<typeof performanceTemplateSnapshot>;
const fields={title,orgId:id,description:z.string().trim().max(200),prompts,goalRules:performanceGoalRules.optional()};
const command=z.discriminatedUnion('action',[z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id,reason:z.string().trim().min(5).max(1500)}).strict()]);
export function applyPerformanceTemplate(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),deny=():never=>{throw new HttpError(403,'没有此组织绩效模板维护权限');},fail=(message:string):never=>{throw new HttpError(400,message);};if(!['admin','hr'].includes(m.role))deny();const old=c.action==='create'?undefined:records.find(r=>r.id===c.id&&r.kind==='performanceTemplate');if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 if(c.action==='archive'){if(old!.status==='archived')fail('模板已经归档');return {...old!,status:'archived',updatedAt:at,payload:{...old!.payload,closedReason:c.reason}};}
 if(c.action==='seal'){if(old!.status!=='draft')fail('只有模板草稿可以定版');if(!state.orgs.some(o=>o.id===old!.payload.orgId&&o.status==='启用'))fail('所属组织已停用');return {...old!,status:'sealed',updatedAt:at};}
 if(c.action==='revise'){const family=records.filter(r=>r.kind==='performanceTemplate'&&r.payload.definitionRootId===old!.payload.definitionRootId);if(old!.status!=='sealed'||family.some(r=>r.status==='draft'||r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))fail('请从没有后续草稿的最新定版修订');return {...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...family.map(r=>r.payload.version??1))+1}};}
 if(old&&old.status!=='draft')fail('只有草稿可编辑');if(!scopedOrgs(state,m).has(c.orgId))deny();if(!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))fail('组织不存在或已停用');if(old&&old.payload.orgId!==c.orgId)fail('模板修订不能更换组织');const key=old?.id??crypto.randomUUID();return {id:key,kind:'performanceTemplate',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,description:c.description,orgId:c.orgId,performancePrompts:c.prompts,performanceGoalRules:c.goalRules,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
export function validatePerformanceResponses(template:PerformanceTemplateSnapshot|undefined,stage:'selfReview'|'evaluation',input:unknown){
 const answers=z.record(z.string().max(50),z.string().trim().max(1000)).parse(input??{}),allowed=template?.prompts.filter(p=>p.stage===stage)??[];if(Object.keys(answers).some(key=>!allowed.some(p=>p.id===key)))throw new HttpError(400,'包含当前阶段不允许填写的模板文本项');if(allowed.some(p=>p.required&&!answers[p.id]))throw new HttpError(400,'请完成本阶段必填模板文本项');return answers;
}

export function validatePerformanceGoalRules(template:PerformanceTemplateSnapshot|undefined,goals:{weight:number}[]){
 const r=template?.goalRules;if(!r)return;if(r.enforceCount!==false&&(goals.length<r.minCount||goals.length>r.maxCount))throw new HttpError(400,`本周期要求目标数量在${r.minCount}至${r.maxCount}项之间`);if(r.enforceWeight!==false&&goals.some(g=>g.weight<r.minWeight||g.weight>r.maxWeight))throw new HttpError(400,`本周期要求每项目标权重在${r.minWeight}%至${r.maxWeight}%之间`);
}
