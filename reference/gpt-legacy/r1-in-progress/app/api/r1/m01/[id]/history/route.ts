import {memberContext} from '@/lib/hris/context';
import {m01Entity} from '@/lib/hris/r1-m01';
import {authorizeTuple,tupleAllowed,type Grant,type Relationship} from '@/lib/hris/r1-authorization';
import {securityStamp,sameStamp} from '@/lib/hris/r1-command';
import {json,failure,HttpError} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
 const {id}=await params,c=await memberContext(),m=c.member,stamp=await securityStamp(c.db,m.tenantId);
 if(!stamp.featuresEnabled)throw new HttpError(409,'新能力尚未开放','FEATURE_NOT_READY');
 const e=await m01Entity(c.db,m.tenantId,id);await authorizeTuple(c.db,m,{objectType:'M01',action:'read',orgId:e.orgId??'',personId:e.kind==='person'?e.id:e.personId??'',field:'record',historyMode:'history'});
 const query=new URL(request.url).searchParams,after=Number(query.get('after')??0);if(!Number.isSafeInteger(after)||after<0)throw new HttpError(400,'分页版本无效','INVALID_CURSOR');
 if(after&&(Number(query.get('revision'))!==c.row.revision||Number(query.get('authorizationRevision'))!==stamp.authorizationRevision||Number(query.get('recoveryEpoch'))!==stamp.recoveryEpoch))throw new HttpError(409,'历史分页已过期','CURSOR_STALE');
 const [history,g,r]=await c.db.batch([
  c.db.prepare('SELECT version,recorded_at AS recordedAt,workspace_revision AS workspaceRevision,history_quality AS historyQuality,payload FROM r1_m01_versions WHERE tenant_id=? AND entity_id=? AND version>? ORDER BY version LIMIT 21').bind(m.tenantId,id,after),
  c.db.prepare("SELECT object_type AS objectType,action,relation_type AS relationType,scope,fields,history_mode AS historyMode,valid_from AS validFrom,valid_to AS validTo FROM r1_permission_grants WHERE tenant_id=? AND member_id=? AND object_type='M01' AND action='read' AND history_mode='history'").bind(m.tenantId,m.userId),
  c.db.prepare('SELECT subject_person_id AS subjectPersonId,relation_type AS relationType,valid_from AS validFrom,valid_to AS validTo FROM r1_relationships WHERE tenant_id=? AND manager_person_id=?').bind(m.tenantId,m.employeeId),
 ]);
 const grants=g.results.map((x:any)=>({...x,scope:JSON.parse(x.scope),fields:JSON.parse(x.fields)})) as Grant[],relations=r.results as Relationship[],items=[];
 for(const h of history.results.slice(0,20) as any[]){const v=JSON.parse(h.payload),can=(field:string)=>tupleAllowed(m,grants,relations,{objectType:'M01',action:'read',orgId:v.orgId??'',personId:v.kind==='person'?v.id:v.personId??'',field,historyMode:'history'});if(!can('record'))continue;delete v.payload.legacyPayload;delete v.payload.migrationSource;
  for(const [key,field] of [['email','email'],['gradeId','level'],['level','level'],['legacyLevelLabel','level']])if(!can(field))delete v.payload[key];
  if(v.payload.fields)v.payload.fields=Object.fromEntries(Object.entries(v.payload.fields).filter(([key])=>can(key)));
  if(v.payload.fieldSnapshots)v.payload.fieldSnapshots=v.payload.fieldSnapshots.filter((f:any)=>can(f.rootId));items.push({...h,payload:v});
 }
 if(!sameStamp(stamp,await securityStamp(c.db,m.tenantId)))throw new HttpError(409,'当前授权已变化','REVISION_CONFLICT');
 return json({items,nextAfter:history.results.length>20?(history.results[19] as any).version:null,revision:c.row.revision,authorizationRevision:stamp.authorizationRevision,recoveryEpoch:stamp.recoveryEpoch});
}catch(e){return failure(e);}}
