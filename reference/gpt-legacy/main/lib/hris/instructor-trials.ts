import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'日期无效');
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('arrange'),profileId:id,title:z.string().trim().min(1).max(200),criteria:z.string().trim().min(10).max(3000),participantIds:z.array(id).min(2).max(10),passingScore:z.number().int().min(0).max(100),due:date,evidence}),
 z.object({action:z.literal('score'),id,score:z.number().int().min(0).max(100),evidence}),
 z.object({action:z.literal('freeze'),id,evidence}),z.object({action:z.literal('cancel'),id,evidence})
]);
export function latestInstructorTrial(records:R[],profileId:string){return records.filter(r=>r.kind==='instructorTrial'&&r.referenceId===profileId).sort((a,b)=>(b.payload.version??1)-(a.payload.version??1))[0];}
export function applyInstructorTrial(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const subject=(employeeId:string)=>{const e=state.employees.find(e=>e.id===employeeId);if(!hr||!e||!scope.has(e.orgId)||employeeId===member.employeeId)deny('须由有范围权限且非试讲本人的HR办理');return e!;};
 if(c.action==='arrange'){
  const p=records.find(r=>r.kind==='instructorProfile'&&r.id===c.profileId);if(!p||!visibleRecord(p,records,state,member))deny('提名不存在或没有访问权限');const profile=p!,e=subject(profile.employeeId!);
  if(profile.status!=='submitted'||e.status==='离职')fail('仅可为在职员工的待复核提名安排试讲');const previous=latestInstructorTrial(records,profile.id);if(previous?.status==='active')fail('此提名已有进行中的试讲');
  if(c.due<businessDate(at))fail('评分截止日不能早于今天');if(new Set(c.participantIds).size!==c.participantIds.length||c.participantIds.includes(e.id))fail('评委不得重复或包含试讲本人');
  if(c.participantIds.some(v=>!state.employees.some(e=>e.id===v&&e.status!=='离职'&&scope.has(e.orgId))))deny('评委须为当前范围内在职员工');
  return {id:crypto.randomUUID(),kind:'instructorTrial',employeeId:e.id,positionId:null,referenceId:profile.id,status:'active',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{name:e.name,title:c.title,criteria:c.criteria,participantIds:c.participantIds,passingScore:c.passingScore,due:c.due,evidence:c.evidence,trialScores:[],version:(previous?.payload.version??0)+1,...(previous?{supersedes:previous.id}:{})}};
 }
 const found=records.find(r=>r.kind==='instructorTrial'&&r.id===c.id);if(!found||!visibleRecord(found,records,state,member))deny('试讲不存在或没有访问权限');const r=found!,p=records.find(p=>p.kind==='instructorProfile'&&p.id===r.referenceId);
 if(r.status!=='active')fail('试讲已冻结或取消');const change=(status:string,payload:R['payload']):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='cancel'){subject(r.employeeId!);return change('cancelled',{closedReason:c.evidence});}
 if(p?.status!=='submitted'||state.employees.find(e=>e.id===r.employeeId)?.status==='离职')fail('关联提名已结束或试讲员工离职，请HR处理');
 if(c.action==='score'){
  const judge=state.employees.find(e=>e.id===member.employeeId);if(!judge||judge.status==='离职'||!r.payload.participantIds?.includes(judge.id)||judge.id===r.employeeId)deny('仅指定在职评委本人可评分');if(businessDate(at)>r.payload.due!)fail('评分截止日已过，请HR核对试讲安排');
  const scores=(r.payload.trialScores??[]).filter(s=>s.employeeId!==judge!.id);scores.push({employeeId:judge!.id,score:c.score,evidence:c.evidence,submittedAt:at});return change('active',{trialScores:scores});
 }
 subject(r.employeeId!);if(r.createdBy===member.userId||member.employeeId&&r.payload.participantIds?.includes(member.employeeId))deny('须由非安排人且非评委的其他HR冻结结果');
 const scores=r.payload.trialScores??[],judges=r.payload.participantIds??[];if(!judges.every(id=>scores.some(s=>s.employeeId===id)))fail('所有指定评委完成评分后才能冻结');
 const sum=judges.reduce((n,id)=>n+scores.find(s=>s.employeeId===id)!.score,0),score=Math.round(sum/judges.length*100)/100;
 return change('published',{score,passed:sum>=r.payload.passingScore!*judges.length,verification:c.evidence,publishedBy:member.userId,publishedAt:at});
}
