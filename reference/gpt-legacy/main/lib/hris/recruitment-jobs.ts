import {z} from 'zod';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),title=z.string().trim().min(1).max(200),optional=z.string().trim().max(500).optional();
export const recruitmentJobDetails=z.object({category:title,employment:title,location:title,address:optional,education:optional,experience:optional,duties:z.string().trim().min(5).max(10000),qualifications:z.string().trim().min(5).max(10000),salary:z.discriminatedUnion('mode',[z.object({mode:z.literal('negotiable')}).strict(),z.object({mode:z.literal('range'),minCents:z.number().int().nonnegative().safe(),maxCents:z.number().int().nonnegative().safe(),currency:z.literal('CNY'),period:z.literal('month')}).strict()])}).strict().superRefine((v,c)=>{if(v.salary.mode==='range'&&v.salary.minCents>v.salary.maxCents)c.addIssue({code:'custom',message:'薪资范围下限不能大于上限'});});
export type RecruitmentJobDetails=z.infer<typeof recruitmentJobDetails>;
export const recruitmentJobSnapshot=z.object({id,rootId:id,version:z.number().int().positive(),title,details:recruitmentJobDetails,workflow:z.literal('legacy-interview-offer-v1')}).strict();
export type RecruitmentJobSnapshot=z.infer<typeof recruitmentJobSnapshot>;
const command=z.discriminatedUnion('action',[z.object({action:z.literal('create'),requisitionId:id,title,details:recruitmentJobDetails}).strict(),z.object({action:z.literal('edit'),id,title,details:recruitmentJobDetails}).strict(),z.object({action:z.literal('activate'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id}).strict()]);
export function applyRecruitmentJob(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),fail=(message:string):never=>{throw new HttpError(400,message);},deny=():never=>{throw new HttpError(403,'没有此招聘职位的管理权限');};
 if(!['admin','hr'].includes(member.role))deny();const old=c.action==='create'?undefined:records.find(r=>r.kind==='recruitmentJob'&&r.id===c.id);if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,member)))deny();const q=records.find(r=>r.kind==='requisition'&&r.id===(c.action==='create'?c.requisitionId:old!.referenceId));if(!q||!visibleRecord(q,records,state,member))deny();
 if(c.action==='archive'){if(old!.status==='archived')fail('职位已经归档');return {...old!,status:'archived',updatedAt:at};}
 if(q!.status!=='active'||!state.positions?.some(p=>p.id===q!.positionId&&p.status==='启用'))fail('职位须关联已批准且仍开放的需求与启用岗位');
 if(c.action==='revise'){if(old!.status!=='active'||records.some(r=>r.kind==='recruitmentJob'&&r.payload.definitionRootId===old!.payload.definitionRootId&&(r.status==='draft'||(r.status==='active'&&(r.payload.version??0)>(old!.payload.version??0)))))fail('请从无后续草稿的最新启用版本修订');return {...old!,id:crypto.randomUUID(),status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...records.filter(r=>r.kind==='recruitmentJob'&&r.payload.definitionRootId===old!.payload.definitionRootId).map(r=>r.payload.version??1))+1}};}
 if(old&&old.status!=='draft')fail('启用后的职位不可覆盖，请创建新版本，既有候选人保留原版本');
 if(c.action==='activate'){recruitmentJobDetails.parse(old!.payload.jobDetails);return {...old!,status:'active',updatedAt:at};}
 const key=old?.id??crypto.randomUUID();return {id:key,kind:'recruitmentJob',employeeId:null,positionId:q!.positionId,referenceId:q!.id,status:'draft',createdBy:old?.createdBy??member.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,jobDetails:c.details,jobWorkflow:'legacy-interview-offer-v1',definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
