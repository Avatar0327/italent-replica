import {memberGrants} from './r1-grants';
import {securityStamp,sameStamp} from './r1-command';
import {HttpError} from './http';
import type {State} from './model';
import type {Member} from './authorization';
import {tupleAllowed,type Relationship} from './r1-authorization';
export async function projectR1CoreState(db:D1Database,m:Member,state:State){
 if(!m.securityStamp?.featuresEnabled)return state;
 const grants=await memberGrants(db,m.tenantId,m.userId,'M01'),r=await db.prepare('SELECT subject_person_id AS subjectPersonId,relation_type AS relationType,valid_from AS validFrom,valid_to AS validTo FROM r1_relationships WHERE tenant_id=? AND manager_person_id=?').bind(m.tenantId,m.employeeId).all<Relationship>();
 const relations=r.results,legacy=await memberGrants(db,m.tenantId,m.userId,'LEGACY');
 const can=(orgId:string,personId:string,field='record',action='read')=>tupleAllowed(m,grants,relations,{objectType:'M01',action,orgId,personId,field,historyMode:'current'})||(action==='read'&&tupleAllowed(m,legacy,[],{objectType:'LEGACY',action:'current.read',orgId,personId:personId||(['employee','payroll_editor','payroll_reviewer'].includes(m.role)?m.employeeId??'':''),field,historyMode:'current'})),s=structuredClone(state);
 s.employees=s.employees.filter(e=>can(e.orgId,e.id)).map(e=>({...e,email:can(e.orgId,e.id,'email')?e.email:'',level:can(e.orgId,e.id,'level')?e.level:'',gradeId:can(e.orgId,e.id,'level')?e.gradeId:null}));
 s.orgs=s.orgs.filter(o=>can(o.id,''));s.positions=s.positions?.filter(p=>can(p.orgId,''));s.grades=s.grades?.filter(()=>s.orgs.some(o=>can(o.id,'','level')));
 s.approvals=s.approvals.filter(a=>{const t=a.details?.transfer;return t?can(t.source.orgId,a.employeeId)||can(t.target.orgId,a.employeeId,'record','transfer.decide'):can(a.orgId,a.employeeId);}).map(a=>{
  const t=a.details?.transfer;if(!t)return a;
  const org=a.steps?.[1]?.userId===m.userId?t.target.orgId:t.source.orgId;
  const level=can(org,a.employeeId,'level')||can(org,a.employeeId,'level','transfer.decide');
  if(!level){a.gradeId=null;t.source.gradeId=null;t.source.level='';t.target.gradeId=null;t.target.level='';}return a;
 });
 if(!sameStamp(m.securityStamp,await securityStamp(db,m.tenantId)))throw new HttpError(409,'当前授权已变化','REVISION_CONFLICT');
 s.audit=[];s.workflows=undefined;return s;
}
