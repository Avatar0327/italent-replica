import type {Grant} from './r1-authorization';
/** Role grants remain independent tuples; role edges narrow each grant's validity interval. */
export async function memberGrants(db:D1Database,tenant:string,memberId:string,objectType:string,action?:string):Promise<Grant[]>{
 const now=new Date().toISOString(),[direct,role]=await db.batch([
 db.prepare('SELECT object_type AS objectType,action,relation_type AS relationType,scope,fields,history_mode AS historyMode,valid_from AS validFrom,valid_to AS validTo FROM r1_permission_grants WHERE tenant_id=? AND member_id=? AND object_type=?'+(action?' AND action=?':'')).bind(tenant,memberId,objectType,...(action?[action]:[])),
 db.prepare("SELECT g.object_type AS objectType,g.action,g.relation_type AS relationType,g.scope,g.fields,g.history_mode AS historyMode,max(g.valid_from,r.valid_from) AS validFrom,CASE WHEN g.valid_to IS NULL THEN r.valid_to WHEN r.valid_to IS NULL THEN g.valid_to ELSE min(g.valid_to,r.valid_to) END AS validTo FROM r1_role_permission_grants g JOIN r1_member_roles r ON r.tenant_id=g.tenant_id AND r.role_id=g.role_id WHERE g.tenant_id=? AND r.member_id=? AND g.object_type=? AND r.active=1 AND r.valid_from<=? AND (r.valid_to IS NULL OR r.valid_to>?)"+(action?' AND g.action=?':'')).bind(tenant,memberId,objectType,now,now,...(action?[action]:[])),
 ]);return [...direct.results,...role.results].map((g:any)=>({...g,scope:JSON.parse(g.scope),fields:JSON.parse(g.fields)}));
}
