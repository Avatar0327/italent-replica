import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const feedbackCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('project'),name:text,orgId:id,templateId:id,start:date,end:date,purpose:evidence,minRespondents:z.number().int().min(3).max(10)}),
 z.object({action:z.literal('invite'),projectId:id,subjectId:id,reviewerEmployeeId:id,relationship:z.enum(['self','supervisor','peer','report'])}),
 z.object({action:z.literal('removeInvite'),id}),
 z.object({action:z.literal('open'),id}),z.object({action:z.literal('close'),id,evidence}),
 z.object({action:z.literal('respond'),inviteId:id,answers:z.array(z.number().int().min(1).max(5)).min(1).max(20)}),
 z.object({action:z.literal('publishReport'),projectId:id,subjectId:id,evidence}),
]);
export function feedbackAggregation(project:R,subjectId:string,records:R[]){return (['self','supervisor','peer','report'] as const).map(relationship=>{const invitations=records.filter(r=>r.kind==='feedbackInvite'&&r.status==='assigned'&&r.referenceId===project.id&&r.payload.subjectId===subjectId&&r.payload.relationship===relationship);const ids=new Set(invitations.map(r=>r.id)),replies=records.filter(r=>r.kind==='feedbackReply'&&r.status==='submitted'&&ids.has(r.referenceId!)),threshold=['self','supervisor'].includes(relationship)?1:project.payload.minRespondents!,suppressed=replies.length<threshold;return {relationship,responses:replies.length,suppressed,averages:suppressed?null:(project.payload.surveyQuestions??[]).map((_,i)=>Math.round(replies.reduce((sum,r)=>sum+r.payload.answers![i],0)/replies.length*10)/10)};});}
export function applyFeedback(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=feedbackCommand.parse(input),scope=scopedOrgs(state,member),hr=['admin','hr'].includes(member.role),today=businessDate(at);
 const deny=(s:string):never=>{throw new HttpError(403,s);},invalid=(s:string):never=>{throw new HttpError(400,s);};
 const manage=()=>{if(!hr)deny('仅HR或管理员可配置和发布360项目');};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e||!scope.has(e.orgId))deny('没有此员工的管理权限');if(e!.status==='离职')invalid('离职员工不能加入评估');return e!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 switch(c.action){
 case 'project':{manage();const t=get(c.templateId,'surveyTemplate');if(t.status!=='published'||!t.payload.surveyQuestions?.every(q=>q.type==='rating'))invalid('360项目须使用已发布的纯量表模板');if(!scope.has(c.orgId)||!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))deny('没有此启用组织的管理权限');if(c.end<c.start||c.end<today)invalid('项目期间无效');return make('feedbackProject',{name:c.name,orgId:c.orgId,start:c.start,end:c.end,purpose:c.purpose,minRespondents:c.minRespondents,surveyQuestions:t.payload.surveyQuestions,version:t.payload.version},{referenceId:t.id});}
 case 'invite':{manage();const p=get(c.projectId,'feedbackProject');if(p.status!=='draft')invalid('发布后评估名单锁定');const subject=employee(c.subjectId),reviewer=employee(c.reviewerEmployeeId);if(!orgWithin(state,subject.orgId,p.payload.orgId!))invalid('被评人不在项目组织范围');if((subject.id===reviewer.id)!==(c.relationship==='self'))invalid('本人关系与评估双方不匹配');if(records.some(r=>r.kind==='feedbackInvite'&&r.status==='assigned'&&r.referenceId===p.id&&r.payload.subjectId===subject.id&&r.employeeId===reviewer.id))invalid('同一评估人不能重复评价同一被评人');return make('feedbackInvite',{subjectId:subject.id,subjectName:subject.name,relationship:c.relationship},{employeeId:reviewer.id,referenceId:p.id,status:'assigned'});}
 case 'removeInvite':{manage();const r=get(c.id,'feedbackInvite');if(get(r.referenceId!,'feedbackProject').status!=='draft'||r.status!=='assigned')invalid('只能移除尚未发布的有效邀请');return change(r,'cancelled');}
 case 'open':{manage();const p=get(c.id,'feedbackProject');if(p.status!=='draft'||p.payload.end!<today)invalid('项目已发布或已过期');if(!records.some(r=>r.kind==='feedbackInvite'&&r.status==='assigned'&&r.referenceId===p.id))invalid('请先配置评估名单');return change(p,'open',{publishedBy:member.userId,publishedAt:at});}
 case 'close':{manage();const p=get(c.id,'feedbackProject');if(p.status!=='open')invalid('仅开放项目可停止收集');return change(p,'closed',{closedReason:c.evidence});}
 case 'respond':{const invite=get(c.inviteId,'feedbackInvite'),p=get(invite.referenceId!,'feedbackProject');if(invite.status!=='assigned'||invite.employeeId!==member.employeeId||!state.employees.some(e=>e.id===member.employeeId&&e.status!=='离职'))deny('仅名单中的评估人本人可填报');if(p.status!=='open'||p.payload.start!>today||p.payload.end!<today)invalid('当前不在开放填报期间');if(c.answers.length!==p.payload.surveyQuestions!.length)invalid('须完成全部题目');const old=records.find(r=>r.kind==='feedbackReply'&&r.referenceId===invite.id);return make('feedbackReply',{answers:c.answers,submittedBy:member.userId,submittedAt:at},{employeeId:member.employeeId,referenceId:invite.id,status:'submitted',...(old?{id:old.id,createdBy:old.createdBy,createdAt:old.createdAt}:{})});}
 case 'publishReport':{manage();const p=get(c.projectId,'feedbackProject');if(p.status!=='closed')invalid('请先停止收集并锁定答卷，再发布报告');if(!records.some(r=>r.kind==='feedbackInvite'&&r.status==='assigned'&&r.referenceId===p.id&&r.payload.subjectId===c.subjectId))invalid('被评人不属于项目');if(records.some(r=>r.kind==='feedbackReport'&&r.referenceId===p.id&&r.employeeId===c.subjectId))invalid('该被评人报告已发布，不重复发布');return make('feedbackReport',{name:p.payload.name,surveyQuestions:p.payload.surveyQuestions,feedbackGroups:feedbackAggregation(p,c.subjectId,records),minRespondents:p.payload.minRespondents,purpose:p.payload.purpose,evidence:c.evidence,publishedBy:member.userId,publishedAt:at},{employeeId:c.subjectId,referenceId:p.id,status:'published'});}
 }
}
