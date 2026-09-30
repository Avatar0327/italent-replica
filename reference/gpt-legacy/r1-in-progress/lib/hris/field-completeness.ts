import type {DevelopmentRecord as R} from './development';
export const requirementLabels={optional:'选填',always:'在职必填',probation:'试用期必填',regular:'正式员工必填'};
export function fieldRequired(def:R,status:string):boolean{
 if(def.kind!=='employeeFieldDefinition'||def.status!=='active'||status==='离职')return false;
 return def.payload.requiredWhen==='always'||def.payload.requiredWhen==='probation'&&status==='试用'||def.payload.requiredWhen==='regular'&&status==='正式';
}
/** Only call with records already projected for the viewer and selected employee. */
export function fieldCompleteness(definitions:R[],values:R[],employeeId:string,status:string){
 const applicable=definitions.filter(d=>fieldRequired(d,status));
 const missing=applicable.filter(d=>{const v=values.find(r=>r.kind==='employeeFieldValue'&&r.employeeId===employeeId&&r.referenceId===d.id)?.payload.fieldValue;return v===null||v===undefined||v==='';});
 return {required:applicable.length,filled:applicable.length-missing.length,missingIds:missing.map(d=>d.id)};
}
