import {z} from 'zod';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),title=z.string().trim().min(1).max(200);
export const performanceInputScore=z.number().min(-1000000).max(1000000).multipleOf(0.01);
const level=z.object({label:title,min:performanceInputScore,max:performanceInputScore,minInclusive:z.boolean(),maxInclusive:z.boolean(),description:z.string().trim().max(2000),talentBand:z.union([z.literal(1),z.literal(2),z.literal(3)])}).strict();
export type RatingLevel=z.infer<typeof level>;
export const ratingLevelsSchema=z.array(level).min(2).max(20).superRefine((levels,ctx)=>{
 if(new Set(levels.map(l=>l.label)).size!==levels.length)ctx.addIssue({code:'custom',message:'等级名称不能重复'});
 levels.forEach((l,i)=>{if(l.min>=l.max)ctx.addIssue({code:'custom',message:'每档下限须小于上限'});const high=levels[i-1];if(high&&(l.max>high.min||l.max===high.min&&l.maxInclusive&&high.minInclusive))ctx.addIssue({code:'custom',message:'等级须从高到低排列且区间不能重叠'});});
});
export type RatingScheme={id:string;rootId:string;version:number;title:string;levels:RatingLevel[]};
export const ratingSchemeSchema=z.object({id,rootId:id,version:z.number().int().positive(),title,levels:ratingLevelsSchema}).strict();
const fields={title,orgId:id,levels:ratingLevelsSchema};
const command=z.discriminatedUnion('action',[z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id}).strict()]);
export function applyPerformanceRating(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),scope=scopedOrgs(state,m),old=c.action==='create'?undefined:records.find(r=>r.kind==='performanceRatingDefinition'&&r.id===c.id);
 const deny=():never=>{throw new HttpError(403,'没有此绩效等级方案的管理权限');},fail=(message:string):never=>{throw new HttpError(400,message);};
 if(!['admin','hr'].includes(m.role)||c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 const orgId=c.action==='create'||c.action==='edit'?c.orgId:old!.payload.orgId!;if(!scope.has(orgId))deny();if(!state.orgs.some(o=>o.id===orgId&&o.status==='启用'))fail('方案组织须启用');
 if(c.action==='archive'){if(old!.status==='archived')fail('方案已经归档');return {...old!,status:'archived',updatedAt:at};}
 if(c.action==='revise'){if(old!.status!=='sealed'||records.some(r=>r.kind===old!.kind&&r.payload.definitionRootId===old!.payload.definitionRootId&&(r.status==='draft'||(r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))))fail('须从无后续草稿的最新定版方案修订');return {...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...records.filter(r=>r.kind==='performanceRatingDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId).map(r=>r.payload.version??1))+1}};}
 if(old&&old.status!=='draft')fail('已定版方案不可修改，请创建后续版本');
 if(c.action==='seal'){ratingLevelsSchema.parse(old!.payload.ratingLevels);return {...old!,status:'sealed',updatedAt:at};}
 if(old&&orgId!==old.payload.orgId)fail('后续版本不能更换所属组织');const key=old?.id??crypto.randomUUID();
 return {id:key,kind:'performanceRatingDefinition',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,orgId,ratingLevels:c.levels,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
export function validatePerformanceScores(cycle:R['payload'],scores:number[]){const scheme=cycle.ratingScheme?ratingSchemeSchema.parse(cycle.ratingScheme):undefined,min=scheme?Math.min(...scheme.levels.map(l=>l.min)):0,max=scheme?Math.max(...scheme.levels.map(l=>l.max)):100;if(scores.some(s=>!Number.isFinite(s)||s<min||s>max))throw new HttpError(400,`每项评分须在本周期尺度 ${min} 至 ${max} 内`);}
export function performanceRatingAt(cycle:R['payload'],score:number):{label:string;band:1|2|3}{
 if(cycle.ratingScheme){const scheme=ratingSchemeSchema.parse(cycle.ratingScheme),matches=scheme.levels.filter(l=>(score>l.min||score===l.min&&l.minInclusive)&&(score<l.max||score===l.max&&l.maxInclusive));if(matches.length!==1)throw new HttpError(400,'总分未唯一匹配冻结等级区间，请核对评级方案，不能自动发布或更正');return {label:matches[0].label,band:matches[0].talentBand};}
 const band=score<cycle.lowCut!?1:score<cycle.highCut!?2:3;return {label:(band===1?cycle.lowLabel:band===2?cycle.midLabel:cycle.highLabel)!,band};
}
