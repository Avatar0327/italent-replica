import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000);
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('link'),profileId:id,enrollmentId:id,mandatory:z.boolean(),evidence}),
 z.object({action:z.literal('remove'),id,evidence})
]);
export function instructorDevelopmentProof(records:R[],profileId:string){return records.filter(r=>r.kind==='instructorDevelopment'&&r.referenceId===profileId&&r.status==='active').map(r=>{const task=records.find(e=>e.kind==='enrollment'&&e.id===r.payload.learningEnrollmentId&&e.employeeId===r.employeeId);return {id:r.id,enrollmentId:r.payload.learningEnrollmentId!,title:r.payload.title??'',mandatory:!!r.payload.mandatory,status:task?.status??'missing',verifiedAt:task?.payload.verifiedAt??null};});}
export function applyInstructorDevelopment(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),scope=scopedOrgs(state,member),hr=['admin','hr'].includes(member.role),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 if(!hr)deny('仅有权限HR可关联认证培养任务');
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const r=c.action==='remove'?get(c.id,'instructorDevelopment'):null,p=get(c.action==='link'?c.profileId:r!.referenceId!,'instructorProfile'),e=state.employees.find(e=>e.id===p.employeeId);
 if(!e||!scope.has(e.orgId)||e.id===member.employeeId)deny('须由非本人的有权限HR关联培养任务');if(p.status!=='submitted')fail('只有待复核提名可调整培养任务关联');
 if(c.action==='remove'){if(r!.status!=='active')fail('关联已移除');return {...r!,status:'removed',updatedAt:at,payload:{...r!.payload,closedReason:c.evidence}};}
 if(e!.status==='离职')fail('离职员工不能增加培养任务关联');const enrollment=get(c.enrollmentId,'enrollment');if(enrollment.employeeId!==p.employeeId||enrollment.status==='cancelled')fail('须引用同员工未取消的真实学习任务');if(records.some(r=>r.kind==='instructorDevelopment'&&r.referenceId===p.id&&r.payload.learningEnrollmentId===enrollment.id&&r.status==='active'))fail('此学习任务已关联当前提名');
 return {id:crypto.randomUUID(),kind:'instructorDevelopment',employeeId:p.employeeId,referenceId:p.id,positionId:null,status:'active',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{learningEnrollmentId:enrollment.id,title:enrollment.payload.title,mandatory:c.mandatory,evidence:c.evidence}};
}
