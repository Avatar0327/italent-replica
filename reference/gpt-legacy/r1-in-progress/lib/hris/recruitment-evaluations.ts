import {z} from 'zod';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200);
export const interviewCriteria=z.array(z.object({id,dimension:text,title:text,description:z.string().trim().max(1500),labels:z.tuple([text,text,text,text])}).strict()).min(1).max(20).superRefine((items,c)=>{if(new Set(items.map(i=>i.id)).size!==items.length)c.addIssue({code:'custom',message:'指标编号不能重复'});if(new Set(items.map(i=>i.dimension)).size>10)c.addIssue({code:'custom',message:'最多10个维度'});});
export type InterviewCriteria=z.infer<typeof interviewCriteria>;
export type InterviewEvaluation={definitionId:string;rootId:string;version:number;title:string;criteria:InterviewCriteria;scores:Record<string,number>;comments:Record<string,string>;scale:'four-level';aggregation:'not-configured'};
const fields={title:text,orgId:id,criteria:interviewCriteria};
const command=z.discriminatedUnion('action',[z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id}).strict()]);
export function applyInterviewDefinition(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),deny=():never=>{throw new HttpError(403,'没有此面试评价表的管理权限');},fail=(message:string):never=>{throw new HttpError(400,message);};
 if(!['admin','hr'].includes(m.role))deny();const old=c.action==='create'?undefined:records.find(r=>r.kind==='interviewDefinition'&&r.id===c.id);if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 const orgId=c.action==='create'||c.action==='edit'?c.orgId:old!.payload.orgId!;if(!scopedOrgs(state,m).has(orgId))deny();
 if(c.action==='archive'){if(old!.status==='archived')fail('评价表已归档');return {...old!,status:'archived',updatedAt:at};}
 if(!state.orgs.some(o=>o.id===orgId&&o.status==='启用'))fail('评价表所属组织须启用');
 if(c.action==='revise'){const family=records.filter(r=>r.kind==='interviewDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId);if(old!.status!=='sealed'||family.some(r=>r.status==='draft'||r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))fail('请从没有后续草稿的最新定版修订');return {...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...family.map(r=>r.payload.version??1))+1}};}
 if(old&&old.status!=='draft')fail('定版内容不可覆盖，请创建后续版本');if(c.action==='seal'){interviewCriteria.parse(old!.payload.interviewCriteria);return {...old!,status:'sealed',updatedAt:at};}
 if(old&&old.payload.orgId!==orgId)fail('后续版本不能更换组织');const key=old?.id??crypto.randomUUID();return {id:key,kind:'interviewDefinition',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,orgId,interviewCriteria:c.criteria,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
export const structuredInterviewFields={definitionId:id,scores:z.record(id,z.number().int().min(1).max(4)),comments:z.record(text,z.string().trim().max(1500))};
export function freezeInterviewEvaluation(def:R,scores:Record<string,number>,comments:Record<string,string>,recommendation:'advance'|'reject'):InterviewEvaluation{
 const criteria=interviewCriteria.parse(def.payload.interviewCriteria),fail=(message:string):never=>{throw new HttpError(400,message);};
 if(def.status!=='sealed')fail('新评价须选已定版且未归档的评价表');if(Object.keys(scores).some(k=>!criteria.some(i=>i.id===k)))fail('评分含未知指标');if(recommendation==='advance'&&criteria.some(i=>scores[i.id]===undefined))fail('通过结论须填写全部指标评分');if(Object.keys(comments).some(k=>!criteria.some(i=>i.dimension===k)))fail('评语含未知维度');
 return {definitionId:def.id,rootId:def.payload.definitionRootId!,version:def.payload.version!,title:def.payload.title!,criteria:structuredClone(criteria),scores:{...scores},comments:{...comments},scale:'four-level',aggregation:'not-configured'};
}
