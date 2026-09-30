import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
const question=z.discriminatedUnion('type',[z.object({type:z.literal('rating'),prompt:text,lowLabel:text,highLabel:text}),z.object({type:z.literal('choice'),prompt:text,options:z.array(text).min(2).max(8).refine(v=>new Set(v).size===v.length,'选项不能重复')})]);
export const surveyCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('template'),code:text,name:text,description:evidence,questions:z.array(question).min(1).max(20)}),
 z.object({action:z.literal('publishTemplate'),id}),z.object({action:z.literal('archiveTemplate'),id}),
 z.object({action:z.literal('round'),templateId:id,name:text,orgId:id,start:date,end:date,purpose:evidence}),
 z.object({action:z.literal('open'),id}),z.object({action:z.literal('close'),id,evidence}),
 z.object({action:z.literal('respond'),roundId:id,answers:z.array(z.number().int().min(0).max(7)).min(1).max(20)}),
 z.object({action:z.literal('withdrawResponse'),id,evidence}),
]);
export function applySurvey(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=surveyCommand.parse(input),scope=scopedOrgs(state,member),today=businessDate(at),hr=['admin','hr'].includes(member.role);
 const deny=(s:string):never=>{throw new HttpError(403,s);},invalid=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const manage=()=>{if(!hr)deny('仅HR或管理员可管理实名问卷项目');};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 const answerable=(r:R)=>{if(r.status!=='open'||r.payload.start!>today||r.payload.end!<today)invalid('不在问卷开放填报期间');if(!member.employeeId||!r.payload.participantIds?.includes(member.employeeId)||!state.employees.some(e=>e.id===member.employeeId&&e.status!=='离职'))deny('当前账号不在填报名单或员工状态无效');};
 switch(c.action){
 case 'template':{manage();return make('surveyTemplate',{code:c.code,name:c.name,description:c.description,surveyQuestions:c.questions,version:1+Math.max(0,...records.filter(r=>r.kind==='surveyTemplate'&&r.payload.code===c.code).map(r=>r.payload.version??0))});}
 case 'publishTemplate':case 'archiveTemplate':{manage();const r=get(c.id,'surveyTemplate');if(c.action==='publishTemplate'){if(r.status!=='draft')invalid('仅草稿可发布');return change(r,'published');}if(r.status!=='published')invalid('模板尚未发布或已停用');return change(r,'archived');}
 case 'round':{manage();const template=get(c.templateId,'surveyTemplate');if(template.status!=='published')invalid('请选择已发布模板');if(!scope.has(c.orgId)||!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))deny('没有此启用组织的管理权限');if(c.end<c.start||c.end<today)invalid('问卷日期无效或已经结束');return make('surveyRound',{name:c.name,orgId:c.orgId,start:c.start,end:c.end,purpose:c.purpose,surveyQuestions:template.payload.surveyQuestions,version:template.payload.version,description:template.payload.description},{referenceId:template.id});}
 case 'open':{manage();const r=get(c.id,'surveyRound');if(r.status!=='draft'||r.payload.end!<today)invalid('问卷已经发布或期间已结束');const participantIds=state.employees.filter(e=>e.status!=='离职'&&orgWithin(state,e.orgId,r.payload.orgId!)).map(e=>e.id);if(!participantIds.length)invalid('组织范围内没有可填报员工');return change(r,'open',{participantIds,publishedBy:member.userId,publishedAt:at});}
 case 'close':{manage();const r=get(c.id,'surveyRound');if(r.status!=='open')invalid('只有开放问卷可结项');return change(r,'closed',{closedReason:c.evidence});}
 case 'respond':{const round=get(c.roundId,'surveyRound');answerable(round);const questions=round.payload.surveyQuestions!;if(c.answers.length!==questions.length||c.answers.some((v,i)=>questions[i].type==='rating'?v<1||v>5:v>=questions[i].options!.length))invalid('请完整回答全部题目并选择有效值');const old=records.find(r=>r.kind==='surveyResponse'&&r.referenceId===round.id&&r.employeeId===member.employeeId);return make('surveyResponse',{answers:c.answers,submittedBy:member.userId,submittedAt:at},{employeeId:member.employeeId,referenceId:round.id,status:'submitted',...(old?{id:old.id,createdAt:old.createdAt,createdBy:old.createdBy}:{})});}
 case 'withdrawResponse':{const r=get(c.id,'surveyResponse');if(r.employeeId!==member.employeeId)deny('仅员工本人可撤回填报');answerable(get(r.referenceId!,'surveyRound'));if(r.status!=='submitted')invalid('填报已撤回');return change(r,'withdrawn',{closedReason:c.evidence});}
 }
}
export function surveySummary(round:R,records:R[]){const responses=records.filter(r=>r.kind==='surveyResponse'&&r.referenceId===round.id&&r.status==='submitted');return {id:round.id,invited:round.payload.participantIds?.length??0,responded:responses.length,questions:(round.payload.surveyQuestions??[]).map((q,i)=>{const values=responses.map(r=>r.payload.answers![i]),options=q.type==='rating'?['1','2','3','4','5']:q.options!;return {prompt:q.prompt,type:q.type,count:values.length,average:q.type==='rating'&&values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*100)/100:null,distribution:options.map((label,j)=>({label,count:values.filter(v=>v===(q.type==='rating'?j+1:j)).length}))};})};}
