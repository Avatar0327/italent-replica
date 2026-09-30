import type {DevelopmentRecord as R} from './development';
type Stage=NonNullable<R['payload']['trainingStages']>[number];
export function trainingStageCompleted(training:R,stage:Stage,records:R[],employeeId:string){
 const optional=new Set(stage.optionalCourseIds??[]),required=stage.courseIds.filter(id=>!optional.has(id));
 const completed=new Set(records.filter(r=>r.kind==='enrollment'&&r.employeeId===employeeId&&r.payload.trainingId===training.id&&r.status==='completed').map(r=>r.referenceId));
 return required.filter(id=>completed.has(id)).length>=(stage.requiredMinimum??required.length)&&[...optional].filter(id=>completed.has(id)).length>=(stage.optionalMinimum??optional.size);
}
export function previousTrainingStagesCompleted(training:R,records:R[],employeeId:string,courseId:string){
 const stages=training.payload.trainingStages??[];if(!stages.length)return true;
 const index=stages.findIndex(stage=>stage.courseIds.includes(courseId));
 return index>=0&&stages.slice(0,index).every(stage=>trainingStageCompleted(training,stage,records,employeeId));
}
