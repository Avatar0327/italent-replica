import {memberGrants} from './r1-grants';
import {z} from 'zod';
import type {Member} from './authorization';
import {tupleAllowed,type Relationship} from './r1-authorization';
import {sameStamp,securityStamp,type SecurityStamp} from './r1-command';
import {HttpError} from './http';
import {contractCounts} from './r1-personnel-data';
const kinds=['regularize_request','person','org','position','job','job_family','grade','legal_entity','employment','assignment','assignment_request','exit_request','identity_review','contract','contract_field','template','subset'] as const;
const cursorSchema=z.object({after:z.string(),kind:z.string(),personId:z.string(),actor:z.string(),revision:z.number().int(),authorizationRevision:z.number().int(),writerEpoch:z.number().int(),recoveryEpoch:z.number().int()}).strict();
export async function readM01(ctx:{db:D1Database;member:Member;row:{revision:number;data:string}},params:URLSearchParams){
 const {db,member:m}=ctx,stamp=await securityStamp(db,m.tenantId);
 if(!stamp.featuresEnabled)return {enabled:false,items:[],nextCursor:null,revision:ctx.row.revision,securityStamp:stamp};
 const kind=z.enum(kinds).parse(params.get('kind')??'person'),personId=z.string().max(100).parse(params.get('personId')??''),limit=z.coerce.number().int().min(1).max(100).parse(params.get('limit')??30);
 let after='';
 if(params.has('cursor')){
  let c:z.infer<typeof cursorSchema>;try{c=cursorSchema.parse(JSON.parse(atob(params.get('cursor')!)));}catch{throw new HttpError(400,'分页凭据无效','INVALID_CURSOR');}
  if(c.kind!==kind||c.personId!==personId||c.actor!==m.userId||c.revision!==ctx.row.revision||c.authorizationRevision!==stamp.authorizationRevision||c.writerEpoch!==stamp.writerEpoch||c.recoveryEpoch!==stamp.recoveryEpoch)throw new HttpError(409,'数据或授权已变化，请从首屏重新读取','CURSOR_STALE');after=c.after;
 }
 const grants=await memberGrants(db,m.tenantId,m.userId,'M01'),r=await db.prepare('SELECT subject_person_id AS subjectPersonId,relation_type AS relationType,valid_from AS validFrom,valid_to AS validTo FROM r1_relationships WHERE tenant_id=? AND manager_person_id=?').bind(m.tenantId,m.employeeId).all<Relationship>();
 const relations=r.results;
 const allowed=(e:any,field:string,action='read',historyMode:'current'|'history'='current')=>tupleAllowed(m,grants,relations,{objectType:'M01',action,orgId:e.orgId??'',personId:e.kind==='person'?e.id:e.personId??'',field,historyMode});
 const rows=await db.prepare('SELECT id,kind,person_id AS personId,org_id AS orgId,code,revision,status,payload FROM r1_m01_entities WHERE tenant_id=? AND kind=? AND id>?'+(personId?' AND person_id=?':'')+' ORDER BY id LIMIT ?').bind(m.tenantId,kind,after,...(personId?[personId]:[]),limit+1).all<any>();
 const scanned=rows.results.slice(0,limit),items=[];
 for(const row of scanned){if(!allowed(row,'record'))continue;const e={...row,payload:JSON.parse(row.payload)};
  delete e.payload.legacyPayload;delete e.payload.migrationSource;
  // No raw identity clues are retained in review objects; field permissions still apply after record permission.
  for(const [key,field] of [['gradeId','level'],['level','level'],['legacyLevelLabel','level'],['email','email']] as const)if(!allowed(e,field))delete e.payload[key];
  if(e.payload.fields)e.payload.fields=Object.fromEntries(Object.entries(e.payload.fields).filter(([field])=>allowed(e,field)));
  if(e.payload.fieldSnapshots)e.payload.fieldSnapshots=e.payload.fieldSnapshots.filter((field:any)=>allowed(e,field.rootId));
  e.allowedActions=[...new Set(grants.map(x=>x.action))].filter(action=>allowed(e,'record',action));items.push(e);
 }
 const now=await securityStamp(db,m.tenantId),revision=await db.prepare('SELECT revision FROM hris_workspaces WHERE owner=?').bind(m.tenantId).first<{revision:number}>();
 if(!sameStamp(stamp,now)||revision?.revision!==ctx.row.revision)throw new HttpError(409,'读取期间数据或授权已变化','REVISION_CONFLICT');
 const nextCursor=rows.results.length>limit?btoa(JSON.stringify({after:scanned.at(-1)!.id,kind,personId,actor:m.userId,revision:ctx.row.revision,authorizationRevision:stamp.authorizationRevision,writerEpoch:stamp.writerEpoch,recoveryEpoch:stamp.recoveryEpoch})):null;
 return {enabled:true,items,nextCursor,revision:ctx.row.revision,securityStamp:stamp,userId:m.userId,role:m.role,contractCounts:kind==='contract'&&!nextCursor&&!params.has('cursor')?contractCounts(items):null,countScope:kind==='contract'?'visible_current_page_only':null};
}
