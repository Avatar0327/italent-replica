import {HttpError} from './http';
import {authorizeTuple} from './r1-authorization';
import {securityStamp,sameStamp} from './r1-command';
import type {memberContext} from './context';
export async function workflowOptions(ctx:Awaited<ReturnType<typeof memberContext>>,orgId:string){
 const {db,member:m}=ctx,t=m.tenantId,stamp=await securityStamp(db,t);if(!stamp.featuresEnabled)throw new HttpError(409,'新能力未开放','FEATURE_NOT_READY');
 const can=async(action:string)=>{try{await authorizeTuple(db,m,{objectType:'M19',action,orgId,personId:'',field:'record',historyMode:'current'});return true;}catch(e){if(e instanceof HttpError&&e.status===403)return false;throw e;}};
 const configure=await can('configure'),transfer=await can('manage.transfer'),start=await can('start');if(!configure&&!transfer&&!start&&!await can('read'))throw new HttpError(403,'没有流程范围权限','FORBIDDEN');
 const [members,templates,delegations]=await db.batch([
  db.prepare('SELECT m.user_id AS id,coalesce(g.name,m.user_id) AS name FROM hris_memberships m LEFT JOIN hris_access_grants g ON g.tenant_id=m.tenant_id AND g.claimed_by=m.user_id WHERE m.tenant_id=? AND m.active=1 AND ?=1 ORDER BY m.user_id LIMIT 101').bind(t,Number(configure||transfer)),
  db.prepare('SELECT r.id,r.business_type AS businessType,r.current_version AS version,r.disabled,t.payload FROM r1_workflow_roots r JOIN r1_workflow_templates t ON t.tenant_id=r.tenant_id AND t.id=r.id AND t.version=r.current_version WHERE r.tenant_id=? AND r.org_id=? ORDER BY r.id LIMIT 101').bind(t,orgId),
  db.prepare('SELECT id,principal_id AS principalId,delegate_id AS delegateId,revision,status,start_at AS startAt,end_at AS endAt,actions,scope,fields,business_types AS businessTypes FROM r1_admin_delegations WHERE tenant_id=? AND (principal_id=? OR delegate_id=?) ORDER BY id LIMIT 101').bind(t,m.userId,m.userId),
 ]);if([members,templates,delegations].some(x=>x.results.length>100))throw new HttpError(503,'请使用更窄的组织查询','BOUNDED_QUERY_REQUIRED');
 if(!sameStamp(stamp,await securityStamp(db,t))||(await db.prepare('SELECT revision FROM hris_workspaces WHERE owner=?').bind(t).first<{revision:number}>())?.revision!==ctx.row.revision)throw new HttpError(409,'读取版本变化','REVISION_CONFLICT');
 return {members:members.results,templates:templates.results.map((x:any)=>({...x,definition:configure?JSON.parse(x.payload):undefined,payload:undefined})),delegations:delegations.results.filter((x:any)=>JSON.parse(x.scope).includes(orgId)).map((x:any)=>({...x,actions:JSON.parse(x.actions),scope:JSON.parse(x.scope),fields:JSON.parse(x.fields),businessTypes:JSON.parse(x.businessTypes)})),configure,start,userId:m.userId,revision:ctx.row.revision,securityStamp:stamp};
}
