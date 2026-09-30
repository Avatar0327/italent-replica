import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(2000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'日期无效');
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('register'),employeeId:id,description:evidence,evidence}),z.object({action:z.literal('suspend'),id,evidence}),
 z.object({action:z.literal('pair'),mentorId:id,employeeId:id,title:text,start:date,end:date,evidence}),z.object({action:z.literal('cancel'),id,evidence}),
 z.object({action:z.literal('record'),pairId:id,id:id.optional(),title:text,evidence,actionPlan:evidence}),z.object({action:z.literal('confirm'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('requestGraduation'),id,evidence}),z.object({action:z.literal('reviewGraduation'),id,accepted:z.boolean(),evidence})
]);
export function applyMentoring(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.kind===kind&&r.id===id);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e)deny('员工不存在');return e!;};
 const manage=(ids:string[])=>{if(!hr||ids.some(id=>!scope.has(employee(id).orgId)||id===member.employeeId))deny('须由对师徒均有范围权限且非当事人的HR办理');};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,employeeId:null,positionId:null,referenceId:null,status:'active',createdBy:member.userId,createdAt:at,updatedAt:at,payload,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='register'){const e=employee(c.employeeId);manage([e.id]);if(e.status==='离职')fail('离职员工不能登记培训导师');if(records.some(r=>r.kind==='mentorProfile'&&r.employeeId===e.id&&r.status==='active'))fail('员工已有在用培训导师登记');return make('mentorProfile',{name:e.name,description:c.description,evidence:c.evidence},{employeeId:e.id});}
 if(c.action==='suspend'){const r=get(c.id,'mentorProfile');manage([r.employeeId!]);if(r.status!=='active')fail('导师已经停用');if(records.some(p=>p.kind==='mentorship'&&p.referenceId===r.id&&['active','submitted'].includes(p.status)))fail('仍有进行中的带教关系，请先完成或终止带教');return change(r,'suspended',{closedReason:c.evidence});}
 if(c.action==='pair'){
  const mentor=get(c.mentorId,'mentorProfile'),a=employee(mentor.employeeId!),b=employee(c.employeeId);manage([a.id,b.id]);if(a.id===b.id)fail('导师和学员不能是同一人');if(mentor.status!=='active'||a.status==='离职'||b.status==='离职')fail('导师及学员须在职，导师登记须在用');if(c.start>c.end||c.end<businessDate(at))fail('带教期间无效或已结束');if(records.some(p=>p.kind==='mentorship'&&p.employeeId===b.id&&p.payload.mentorEmployeeId===a.id&&['active','submitted'].includes(p.status)&&p.payload.start!<=c.end&&p.payload.end!>=c.start))fail('同一师徒已有期间重叠的带教安排');
  return make('mentorship',{title:c.title,name:b.name,mentorName:a.name,mentorEmployeeId:a.id,start:c.start,end:c.end,evidence:c.evidence},{employeeId:b.id,referenceId:mentor.id});
 }
 if(c.action==='record'){
  const p=get(c.pairId,'mentorship');if(p.payload.mentorEmployeeId!==member.employeeId)deny('仅本关系的导师本人可记录辅导');if(p.status!=='active'||employee(p.employeeId!).status==='离职'||employee(p.payload.mentorEmployeeId!).status==='离职')fail('关系或人员状态不支持新的辅导记录');if(businessDate(at)<p.payload.start!||businessDate(at)>p.payload.end!)fail('不在带教期间');const old=c.id?get(c.id,'mentoringLog'):null;if(old&&(old.referenceId!==p.id||!['submitted','returned'].includes(old.status)||old.createdBy!==member.userId))fail('仅可修改本关系中本人尚未确认的记录');
  return make('mentoringLog',{title:c.title,evidence:c.evidence,actionPlan:c.actionPlan,mentorEmployeeId:p.payload.mentorEmployeeId,mentorName:p.payload.mentorName,name:p.payload.name},{employeeId:p.employeeId,referenceId:p.id,status:'submitted',...(old?{id:old.id,createdAt:old.createdAt,createdBy:old.createdBy}:{})});
 }
 if(c.action==='confirm'){const r=get(c.id,'mentoringLog'),p=get(r.referenceId!,'mentorship');if(r.employeeId!==member.employeeId)deny('仅本关系的学员本人可确认辅导记录');if(r.status!=='submitted'||p.status!=='active'||employee(r.employeeId!).status==='离职')fail('当前记录或关系不能确认');return change(r,c.accepted?'confirmed':'returned',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});}
 const x=c as Extract<z.infer<typeof command>,{action:'cancel'|'requestGraduation'|'reviewGraduation'}>,p=get(x.id,'mentorship'),ids=[p.employeeId!,p.payload.mentorEmployeeId!];
 if(x.action==='cancel'){manage(ids);if(!['active','submitted'].includes(p.status))fail('带教已经结束');return change(p,'cancelled',{closedReason:x.evidence});}
 if(x.action==='requestGraduation'){if(member.employeeId!==p.payload.mentorEmployeeId)deny('仅导师本人可提出出师核对');if(p.status!=='active'||ids.some(id=>employee(id).status==='离职'))fail('关系或人员状态不能申请出师');const logs=records.filter(r=>r.kind==='mentoringLog'&&r.referenceId===p.id);if(!logs.length||logs.some(r=>r.status!=='confirmed'))fail('至少需要一项学员确认的辅导记录，且不能有待处理记录');return change(p,'submitted',{graduationEvidence:x.evidence,submittedBy:member.userId,submittedAt:at});}
 manage(ids);if(p.status!=='submitted')fail('没有待核对的出师申请');if(p.createdBy===member.userId)deny('出师须由非关系安排人的其他HR独立核对');if(x.accepted&&ids.some(id=>employee(id).status==='离职'))fail('当事人已离职，请核对并终止或退回关系');return change(p,x.accepted?'closed':'active',{verification:x.evidence,verifiedBy:member.userId,verifiedAt:at,...(x.accepted?{graduatedAt:at}:{})});
}
