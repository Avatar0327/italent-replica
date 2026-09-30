import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'日期无效');
export const instructorCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('submit'),employeeId:id,courseId:id,start:date,end:date,evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
 z.object({action:z.literal('revoke'),id,evidence}),
]);
export function applyInstructor(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=instructorCommand.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member);
 const deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 const subject=(employeeId:string)=>{const e=state.employees.find(e=>e.id===employeeId);if(!e||!(e.id===member.employeeId||hr&&scope.has(e.orgId)))deny('没有此员工的讲师认证权限');return e!;};
 const duplicate=(employeeId:string,courseId:string,start:string,end:string,except?:string)=>records.some(r=>r.id!==except&&r.kind==='instructorCertification'&&r.employeeId===employeeId&&r.referenceId===courseId&&['submitted','approved'].includes(r.status)&&r.payload.start!<=end&&r.payload.end!>=start);
 if(c.action==='submit'){
  const e=subject(c.employeeId),course=records.find(r=>r.id===c.courseId&&r.kind==='course');
  if(e.status==='离职')fail('离职员工不能申请新的讲师认证');
  if(!course||!visibleRecord(course,records,state,member)||course.status!=='published')throw new HttpError(400,'请选择已发布的课程版本');
  if(c.end<c.start||c.end<businessDate(at))fail('认证期间无效或已经过期');
  if(duplicate(e.id,course.id,c.start,c.end))fail('此员工和课程版本已有期间重叠的待审或有效认证');
  return {id:crypto.randomUUID(),kind:'instructorCertification',employeeId:e.id,referenceId:course.id,positionId:null,status:'submitted',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{title:course.payload.title,version:course.payload.version,name:e.name,start:c.start,end:c.end,evidence:c.evidence}};
 }
 const r=records.find(r=>r.id===c.id&&r.kind==='instructorCertification');
 if(!r||!visibleRecord(r,records,state,member))deny('认证不存在或没有访问权限');
 const record=r!,e=subject(record.employeeId!);
 const change=(status:string,payload:R['payload']):R=>({...record,status,updatedAt:at,payload:{...record.payload,...payload}});
 if(c.action==='withdraw'){if(record.createdBy!==member.userId)deny('仅申请提交人可以撤回');if(record.status!=='submitted')fail('只有待审认证可以撤回');return change('withdrawn',{closedReason:c.evidence});}
 if(!hr||!scope.has(e.orgId)||e.id===member.employeeId||record.createdBy===member.userId)deny('须由其他有权限HR独立办理，不能办理本人或本人提交的认证');
 if(c.action==='review'){
  if(record.status!=='submitted')fail('认证已处理');
  if(c.accepted){if(e.status==='离职'||record.payload.end!<businessDate(at))fail('员工已离职或认证期间已过期');const course=records.find(x=>x.id===record.referenceId&&x.kind==='course');if(course?.status!=='published')fail('课程已停用，不能通过认证');if(duplicate(e.id,record.referenceId!,record.payload.start!,record.payload.end!,record.id))fail('存在期间重叠的认证');}
  return change(c.accepted?'approved':'rejected',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});
 }
 if(record.status!=='approved')fail('只有已通过的认证可以撤销');
 return change('revoked',{revocationReason:c.evidence,revokedBy:member.userId,revokedAt:at});
}
