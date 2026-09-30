import {instructorDevelopmentProof} from './instructor-development';
import {latestInstructorTrial} from './instructor-trials';
import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000);
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('nominate'),employeeId:id,instructorApplicationId:id.optional(),title:z.string().trim().min(1).max(100),description:z.string().trim().min(5).max(1000),evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
 z.object({action:z.literal('suspend'),id,evidence})
]);
export function applyInstructorDirectory(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),scope=scopedOrgs(state,member),hr=['admin','hr'].includes(member.role);
 const deny=(message:string):never=>{throw new HttpError(403,message);},fail=(message:string):never=>{throw new HttpError(400,message);};
 if(!hr)deny('仅有权限的HR可办理内部讲师名册');
 const employee=(employeeId:string)=>{const e=state.employees.find(e=>e.id===employeeId);if(!e||!scope.has(e.orgId))deny('没有此员工的讲师名册权限');return e!;};
 if(c.action==='nominate'){
  const e=employee(c.employeeId);if(e.status==='离职')fail('离职员工不能提名为内部讲师');
  const previous=records.filter(r=>r.kind==='instructorProfile'&&r.employeeId===e.id);
  if(previous.some(r=>['submitted','active'].includes(r.status)))fail('此员工已有待复核或在用的讲师记录');
  let application:R|undefined;if(c.instructorApplicationId){application=records.find(a=>a.kind==='instructorApplication'&&a.id===c.instructorApplicationId);if(!application||!visibleRecord(application,records,state,member))deny('报名不存在或无权访问');const campaign=records.find(a=>a.kind==='instructorCampaign'&&a.id===application!.referenceId);if(application!.status!=='approved'||application!.employeeId!==e.id||!campaign||!orgWithin(state,e.orgId,campaign.payload.orgId!))fail('须引用同员工、仍符合活动范围且已独立复核的报名');if(records.some(p=>p.kind==='instructorProfile'&&p.payload.instructorApplicationId===application!.id))fail('此报名已关联其他提名');}
  const latest=previous.sort((a,b)=>(b.payload.version??1)-(a.payload.version??1))[0];
  return {id:crypto.randomUUID(),kind:'instructorProfile',employeeId:e.id,positionId:null,referenceId:null,status:'submitted',createdBy:member.userId,createdAt:at,updatedAt:at,payload:{name:e.name,title:application?.payload.instructorLevel??c.title,description:application?.payload.description??c.description,...(application?{instructorApplicationId:application.id,requiresTrial:true}:{}),evidence:c.evidence,version:(latest?.payload.version??0)+1,...(latest?{supersedes:latest.id}:{})}};
 }
 const r=records.find(r=>r.kind==='instructorProfile'&&r.id===c.id);if(!r||!visibleRecord(r,records,state,member))deny('讲师记录不存在或没有访问权限');const record=r!,e=employee(record.employeeId!);
 const trial=latestInstructorTrial(records,record.id);if((c.action==='review'||c.action==='withdraw')&&trial?.status==='active')fail('先完成或取消进行中的试讲，再办理提名');
 const change=(status:string,payload:R['payload']):R=>({...record,status,updatedAt:at,payload:{...record.payload,...payload}});
 if(c.action==='withdraw'){if(record.createdBy!==member.userId)deny('仅提名人可撤回');if(record.status!=='submitted')fail('仅待复核提名可撤回');return change('withdrawn',{closedReason:c.evidence});}
 if(e.id===member.employeeId)deny('不能复核或停用本人的讲师身份');
 if(c.action==='review'){
  if(record.createdBy===member.userId)deny('须由其他HR独立复核提名');if(record.status!=='submitted')fail('提名已经处理');
  if(c.accepted){if(instructorDevelopmentProof(records,record.id).some(p=>p.mandatory&&p.status!=='completed'))fail('必修培养任务须完成独立成果核验后才能入册');if(record.payload.requiresTrial&&!trial)fail('活动报名产生的提名须先完成指定评委试讲');if(trial&&(trial.status!=='published'||!trial.payload.passed))fail('安排过试讲的提名须有最新冻结且通过的试讲结果');if(e.status==='离职')fail('员工已离职，不能通过讲师提名');if(records.some(x=>x.kind==='instructorProfile'&&x.id!==record.id&&x.employeeId===e.id&&x.status==='active'))fail('员工已有在用的讲师记录');}
  return change(c.accepted?'active':'rejected',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at,...(c.accepted?{developmentProof:instructorDevelopmentProof(records,record.id)}:{}),...(c.accepted&&trial?{trialId:trial.id,score:trial.payload.score}:{})});
 }
 if(record.status!=='active')fail('仅在用的讲师记录可以停用');return change('suspended',{closedReason:c.evidence,revokedBy:member.userId,revokedAt:at});
}
