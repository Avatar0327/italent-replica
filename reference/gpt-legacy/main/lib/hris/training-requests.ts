import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(3000);
export const trainingRequestCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('request'),courseId:id,evidence}),
 z.object({action:z.literal('decide'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
 z.object({action:z.literal('arrange'),id,enrollmentId:id,evidence}),
]);
export function applyTrainingRequest(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=trainingRequestCommand.parse(input),hr=['admin','hr'].includes(m.role),manager=hr||m.role==='manager',scope=scopedOrgs(state,m);
 const fail=(text:string):never=>{throw new HttpError(400,text);},deny=():never=>{throw new HttpError(403,'没有此培训申请的办理权限');};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(x=>x.id===id&&x.kind===kind);if(!r||!visibleRecord(r,records,state,m))deny();return r!;};
 if(c.action==='request'){
  const e=state.employees.find(e=>e.id===m.employeeId);if(!e)deny();if(e!.status==='离职')fail('离职员工不能提出新的培训申请');const course=get(c.courseId,'course');if(course.status!=='published')fail('只能申请已发布课程版本');
  if(records.some(r=>r.kind==='trainingRequest'&&r.employeeId===e!.id&&r.referenceId===course.id&&['submitted','approved'].includes(r.status)))fail('此课程版本已有在途申请');
  if(records.some(r=>r.kind==='enrollment'&&r.employeeId===e!.id&&r.referenceId===course.id))fail('此课程版本已有学习记录，请进入学习中心查看');
  return {id:crypto.randomUUID(),kind:'trainingRequest',employeeId:e!.id,positionId:null,referenceId:course.id,status:'submitted',payload:{title:course.payload.title,version:course.payload.version,evidence:c.evidence},createdBy:m.userId,createdAt:at,updatedAt:at};
 }
 const r=get(c.id,'trainingRequest'),e=state.employees.find(e=>e.id===r.employeeId);if(!e)deny();
 const change=(status:string,payload:R['payload']):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 if(c.action==='withdraw'){if(r.employeeId!==m.employeeId||r.createdBy!==m.userId)deny();if(!['submitted','approved'].includes(r.status))fail('仅待审或待安排申请可撤回');return change('withdrawn',{closedReason:c.evidence});}
 if(!manager||!scope.has(e!.orgId)||r.employeeId===m.employeeId||r.createdBy===m.userId)deny();
 if(c.action==='decide'){if(r.status!=='submitted')fail('申请已处理');if(c.accepted&&(e!.status==='离职'||get(r.referenceId!,'course').status!=='published'))fail('员工已离职或课程已停用，不能批准');return change(c.accepted?'approved':'rejected',{approvedBy:m.userId,approvedAt:at,verification:c.evidence});}
 if(!hr)deny();if(r.status!=='approved')fail('须先独立批准申请');if(e!.status==='离职')fail('员工已离职，不能确认新的学习安排');const enrollment=get(c.enrollmentId,'enrollment');
 if(enrollment.employeeId!==r.employeeId||enrollment.referenceId!==r.referenceId||enrollment.status==='cancelled'||enrollment.createdAt<=r.payload.approvedAt!)fail('须引用批准后创建、同员工同课程版本的有效学习任务');
 if(records.some(x=>x.kind==='trainingRequest'&&x.payload.learningEnrollmentId===enrollment.id))fail('此学习任务已关联其他申请');
 return change('arranged',{learningEnrollmentId:enrollment.id,arrangementEvidence:c.evidence,arrangedBy:m.userId,arrangedAt:at});
}
