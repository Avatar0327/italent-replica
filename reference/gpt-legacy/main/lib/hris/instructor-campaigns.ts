import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'日期无效');
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),title:z.string().trim().min(1).max(200),orgId:id,instructorLevel:z.string().trim().min(1).max(100),description:z.string().trim().min(5).max(1000),criteria:z.string().trim().min(10).max(1000),start:date,end:date,evidence}),
 z.object({action:z.literal('publish'),id}),z.object({action:z.literal('closeSignup'),id,evidence}),z.object({action:z.literal('cancelDraft'),id,evidence}),
 z.object({action:z.literal('apply'),campaignId:id,evidence}),z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),z.object({action:z.literal('withdraw'),id,evidence})
]);
export function applyInstructorCampaign(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,employeeId:null,referenceId:null,positionId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,payload,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='create'){
  if(!hr||!scope.has(c.orgId))deny('没有此组织的认证活动管理权限');if(!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))fail('请选择启用的活动组织');if(c.start>c.end||c.end<businessDate(at))fail('报名期间无效或已结束');
  return make('instructorCampaign',{title:c.title,orgId:c.orgId,instructorLevel:c.instructorLevel,description:c.description,criteria:c.criteria,start:c.start,end:c.end,evidence:c.evidence});
 }
 if(['publish','closeSignup','cancelDraft'].includes(c.action)){
  const x=c as Extract<z.infer<typeof command>,{action:'publish'|'closeSignup'|'cancelDraft'}>,r=get(x.id,'instructorCampaign');if(!hr||!scope.has(r.payload.orgId!))deny('没有此活动的管理权限');
  if(x.action==='publish'){if(r.status!=='draft'||r.payload.end!<businessDate(at)||!state.orgs.some(o=>o.id===r.payload.orgId&&o.status==='启用'))fail('仅报名未结束、组织启用的草稿可以发布');return change(r,'published',{publishedAt:at,publishedBy:member.userId});}
  if(x.action==='cancelDraft'){if(r.status!=='draft')fail('仅草稿活动可取消');return change(r,'cancelled',{closedReason:x.evidence});}
  if(r.status!=='published')fail('仅已发布活动可停止报名');return change(r,'closed',{closedReason:x.evidence});
 }
 if(c.action==='apply'){
  const r=get(c.campaignId,'instructorCampaign'),e=state.employees.find(e=>e.id===member.employeeId);if(!e||!orgWithin(state,e.orgId,r.payload.orgId!))deny('仅活动范围内员工本人可报名');if(e!.status==='离职')fail('离职员工不能报名');if(r.status!=='published'||businessDate(at)<r.payload.start!||businessDate(at)>r.payload.end!)fail('不在活动开放报名期间');
  if(records.some(a=>a.kind==='instructorApplication'&&a.referenceId===r.id&&a.employeeId===e!.id&&['submitted','approved'].includes(a.status)))fail('此活动已有在途或已通过报名');if(records.some(p=>p.kind==='instructorProfile'&&p.employeeId===e!.id&&['submitted','active'].includes(p.status)))fail('已有待复核或在用讲师身份，请先核对现有名册');
  return make('instructorApplication',{title:r.payload.title,instructorLevel:r.payload.instructorLevel,description:r.payload.description,criteria:r.payload.criteria,evidence:c.evidence},{employeeId:e!.id,referenceId:r.id,status:'submitted'});
 }
 const x=c as Extract<z.infer<typeof command>,{action:'review'|'withdraw'}>,r=get(x.id,'instructorApplication'),e=state.employees.find(e=>e.id===r.employeeId);if(!e)deny('员工不存在');
 if(records.some(p=>p.kind==='instructorProfile'&&p.payload.instructorApplicationId===r.id))fail('报名已关联讲师提名，请在名册及试讲流程中办理');
 if(x.action==='withdraw'){if(r.employeeId!==member.employeeId||r.createdBy!==member.userId)deny('仅报名本人可以撤回');if(!['submitted','approved'].includes(r.status))fail('报名已经结束');return change(r,'withdrawn',{closedReason:x.evidence});}
 if(!hr||!scope.has(e!.orgId)||member.employeeId===e!.id||r.createdBy===member.userId)deny('须由非本人的其他有权限HR独立复核报名');if(r.status!=='submitted')fail('报名已经处理');
 if(x.accepted){const campaign=get(r.referenceId!,'instructorCampaign');if(e!.status==='离职'||!orgWithin(state,e!.orgId,campaign.payload.orgId!)||!['published','closed'].includes(campaign.status))fail('员工状态或活动范围不再符合要求');}
 return change(r,x.accepted?'approved':'rejected',{verification:x.evidence,approvedAt:at,approvedBy:member.userId});
}
