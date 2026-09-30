import {businessDate} from './business-time';
import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000);
export const creditCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('policy'),courseId:id,creditUnits:z.number().int().min(1).max(1000000),validityDays:z.number().int().min(1).max(36500).optional(),evidence}),
 z.object({action:z.literal('award'),enrollmentId:id,evidence}),
 z.object({action:z.literal('reverse'),awardId:id,evidence}),
]);
export function repeatCreditInstance(records:R[],enrollment:R){
 const instance=records.find(r=>r.kind==='learningAssignment'&&r.id===enrollment.payload.learningAssignmentId&&r.employeeId===enrollment.employeeId);
 return instance?.payload.learningMode?.mode==='recurring'&&instance.payload.learningMode.repeatCredit&&(instance.payload.round??1)>1&&!!instance.payload.previousAssignmentId&&!enrollment.payload.sourceEnrollmentId?instance:undefined;
}
export function courseCreditAlreadyGranted(records:R[],enrollment:R){const repeat=repeatCreditInstance(records,enrollment),ids=new Set(records.filter(r=>r.kind==='enrollment'&&r.employeeId===enrollment.employeeId&&r.referenceId===enrollment.referenceId&&(!repeat||r.payload.learningAssignmentId===repeat.id)).map(r=>r.id));return records.some(r=>r.kind==='learningCredit'&&ids.has(r.referenceId!));}
export function learningCreditSummary(records:R[],asOf=businessDate()){
 const totals=new Map<string,{employeeId:string;awardedUnits:number;reversedUnits:number;netUnits:number;expiredUnits:number;availableUnits:number}>(),reversed=new Set(records.filter(r=>r.kind==='creditReversal').map(r=>r.referenceId));
 for(const r of records.filter(r=>['learningCredit','creditReversal'].includes(r.kind))){const row=totals.get(r.employeeId!)??{employeeId:r.employeeId!,awardedUnits:0,reversedUnits:0,netUnits:0,expiredUnits:0,availableUnits:0};if(r.kind==='learningCredit'){row.awardedUnits+=r.payload.creditUnits??0;if(!reversed.has(r.id)&&r.payload.validUntil&&r.payload.validUntil<asOf)row.expiredUnits+=r.payload.creditUnits??0;}else row.reversedUnits+=r.payload.creditUnits??0;row.netUnits=row.awardedUnits-row.reversedUnits;row.availableUnits=row.netUnits-row.expiredUnits;totals.set(row.employeeId,row);}return [...totals.values()];
}
export function applyLearningCredit(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=creditCommand.parse(input);if(!['admin','hr'].includes(member.role))throw new HttpError(403,'仅HR或管理员可维护学分台账');
 const fail=(s:string):never=>{throw new HttpError(400,s);},deny=(s:string):never=>{throw new HttpError(403,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e||!scopedOrgs(state,member).has(e.orgId))deny('没有此员工的学分管理权限');if(id===member.employeeId)deny('不能登记或撤销本人的学分');};
 const make=(kind:R['kind'],payload:R['payload'],referenceId:string,employeeId:string|null=null):R=>({id:crypto.randomUUID(),kind,payload,referenceId,employeeId,positionId:null,status:'recorded',createdBy:member.userId,createdAt:at,updatedAt:at});
 if(c.action==='policy'){const course=get(c.courseId,'course');if(course.status==='archived')fail('停用课程不能新增学分规则');if(records.some(r=>r.kind==='courseCreditPolicy'&&r.referenceId===course.id))fail('此课程版本已有固定学分规则；调整学分请建立新课程版本');return make('courseCreditPolicy',{title:course.payload.title,version:course.payload.version,creditUnits:c.creditUnits,validityDays:c.validityDays,evidence:c.evidence},course.id);}
 if(c.action==='award'){const enrollment=get(c.enrollmentId,'enrollment');employee(enrollment.employeeId!);if(enrollment.status!=='completed'||!enrollment.payload.verifiedBy)fail('须先完成学习成果的独立核验');const policy=records.find(r=>r.kind==='courseCreditPolicy'&&r.referenceId===enrollment.referenceId);if(!policy)fail('此课程版本尚未配置学分');if(records.some(r=>r.kind==='learningCredit'&&r.referenceId===enrollment.id))fail('此学习记录已登记过学分，不能重复授予');const repeat=repeatCreditInstance(records,enrollment);if(repeat&&repeat.status!=='completed')fail('允许重复学分的新轮次须先整轮结项');if(courseCreditAlreadyGranted(records,enrollment))fail('此课程或轮次已授予学分，不能重复授予');const awardedOn=businessDate(at),validityDays=policy!.payload.validityDays,validUntil=validityDays?new Date(Date.parse(awardedOn+'T00:00:00Z')+(validityDays-1)*86400000).toISOString().slice(0,10):undefined;return make('learningCredit',{learningAssignmentId:enrollment.payload.learningAssignmentId,round:records.find(r=>r.id===enrollment.payload.learningAssignmentId)?.payload.round,repeatCreditApplied:!!repeat,awardedOn,validityDays,validUntil,title:policy!.payload.title,version:policy!.payload.version,creditUnits:policy!.payload.creditUnits,evidence:c.evidence,source:policy!.id,verifiedBy:enrollment.payload.verifiedBy,verifiedAt:enrollment.payload.verifiedAt},enrollment.id,enrollment.employeeId);}
 const award=get(c.awardId,'learningCredit');employee(award.employeeId!);if(award.createdBy===member.userId)deny('撤销须由其他有权限HR独立核实');if(records.some(r=>r.kind==='creditReversal'&&r.referenceId===award.id))fail('此学分已经撤销');return make('creditReversal',{title:award.payload.title,version:award.payload.version,creditUnits:award.payload.creditUnits,evidence:c.evidence},award.id,award.employeeId);
}
