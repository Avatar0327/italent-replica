import {z} from 'zod';
import {businessDate} from './business-time';
import type {DevelopmentRecord as R} from './development';
type Learner={orgId:string;status:string}|undefined|null;
export function learningTaskCurrent(r:R,employee:Learner){return !r.payload.requirementRetiredAt&&(!r.payload.learningAssignmentId||!r.payload.assignmentCancelled&&!!employee&&employee.status!=='离职'&&employee.orgId===r.payload.assignmentOrgId);}
export function learningTaskOpen(r:R,employee:Learner,at=new Date().toISOString()){
 return learningTaskCurrent(r,employee)&&(!r.payload.learningAssignmentId||businessDate(at)>=r.payload.assignmentStart!&&(!!r.payload.assignmentAllowOverdue||businessDate(at)<=r.payload.assignmentDue!));
}

// Internal contract only: no automatic enrollment, recurrence or reward side effects.
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const d=new Date(value+'T00:00:00Z');
 return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
},'Invalid calendar date');
const common={progressSync:z.boolean(),orderedStages:z.boolean()};
const durationDays=z.number().int().min(1).max(36500);
export const learningModeSchema=z.discriminatedUnion('mode',[
 z.object({...common,mode:z.literal('relative'),durationDays,allowOverdue:z.boolean()}).strict(),
 z.object({...common,mode:z.literal('fixed'),start:date,end:date}).strict(),
 z.object({...common,mode:z.literal('recurring'),durationDays,allowOverdue:z.boolean(),repeatCredit:z.boolean(),repeatPoints:z.boolean()}).strict(),
]).superRefine((value,ctx)=>{
 if(value.mode==='fixed'&&value.end<value.start)ctx.addIssue({code:z.ZodIssueCode.custom,path:['end'],message:'End must not precede start'});
});
export type LearningMode=z.infer<typeof learningModeSchema>;

export function learningWindow(input:unknown,startsOn:string){
 const config=learningModeSchema.parse(input),start=date.parse(startsOn);
 if(config.mode==='fixed')return {start:config.start,due:config.end,allowOverdue:false};
 const end=new Date(start+'T00:00:00Z');
 // Inclusive business dates: one day assigned today is due today.
 end.setUTCDate(end.getUTCDate()+config.durationDays-1);
 const due=date.parse(end.toISOString().slice(0,10));
 return {start,due,allowOverdue:config.allowOverdue};
}

export function learningAssignmentKey(planVersionId:string,employeeId:string,round:number){
 const identity=z.string().min(1).max(100);
 // Tuple encoding avoids delimiter collisions and never uses employee names.
 return JSON.stringify([identity.parse(planVersionId),identity.parse(employeeId),z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(round)]);
}
