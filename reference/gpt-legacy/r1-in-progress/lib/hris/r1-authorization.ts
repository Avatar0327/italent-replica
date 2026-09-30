import {memberGrants} from './r1-grants';
import type {Member} from './authorization';
import {requireMember} from './authorization';
import {securityStamp,sameStamp} from './r1-command';
import {HttpError} from './http';

export type Grant={objectType:string;action:string;relationType:string;scope:string[];fields:string[];historyMode:string;validFrom:string;validTo:string|null};
export type AccessTuple={objectType:string;action:string;orgId:string;personId:string;field:string;historyMode:'current'|'history';denied?:boolean};
export type Relationship={subjectPersonId:string;relationType:string;validFrom:string;validTo:string|null};
const effective=(from:string,to:string|null,at:string)=>from<=at&&(!to||at<to);
/** Each grant must satisfy the whole tuple. Never combine scope from A with fields from B. */
export function tupleAllowed(m:Member,grants:Grant[],relations:Relationship[],q:AccessTuple,at=new Date().toISOString()){
 requireMember(m);if(q.denied)return false;
 return grants.some(g=>g.objectType===q.objectType&&g.action===q.action&&g.fields.includes(q.field)&&g.historyMode===q.historyMode&&effective(g.validFrom,g.validTo,at)&&
  (g.scope.includes(q.orgId))&&
  (g.relationType==='scope'||g.relationType==='self'&&m.employeeId===q.personId||relations.some(r=>r.subjectPersonId===q.personId&&r.relationType===g.relationType&&effective(r.validFrom,r.validTo,at))));
}
export async function authorizeTuple(db:D1Database,m:Member,q:AccessTuple){
 const start=await securityStamp(db,m.tenantId);
 if(!m.securityStamp||!sameStamp(start,m.securityStamp))throw new HttpError(409,'授权已变化','REVISION_CONFLICT');
 const parsed=await memberGrants(db,m.tenantId,m.userId,q.objectType,q.action),relations=await db.prepare('SELECT subject_person_id AS subjectPersonId,relation_type AS relationType,valid_from AS validFrom,valid_to AS validTo FROM r1_relationships WHERE tenant_id=? AND manager_person_id=? AND subject_person_id=?').bind(m.tenantId,m.employeeId,q.personId).all<Relationship>();
 if(!tupleAllowed(m,parsed,relations.results as Relationship[],q)||!sameStamp(start,await securityStamp(db,m.tenantId)))throw new HttpError(403,'没有此对象动作或字段权限','FORBIDDEN');
 const at=new Date().toISOString(),rs=relations.results as Relationship[],ends=parsed.filter(g=>tupleAllowed(m,[g],rs,q,at)).map(g=>{const grantEnd=g.validTo?Date.parse(g.validTo):Number.MAX_SAFE_INTEGER;const relationEnd=['scope','self'].includes(g.relationType)?Number.MAX_SAFE_INTEGER:Math.max(...rs.filter(r=>r.relationType===g.relationType&&r.subjectPersonId===q.personId&&effective(r.validFrom,r.validTo,at)).map(r=>r.validTo?Date.parse(r.validTo):Number.MAX_SAFE_INTEGER));return Math.min(grantEnd,relationEnd);});
 if(!ends.length)throw new HttpError(403,'权限有效期已结束','FORBIDDEN');m.permissionValidUntil=Math.min(m.permissionValidUntil??Number.MAX_SAFE_INTEGER,Math.max(...ends));
}
