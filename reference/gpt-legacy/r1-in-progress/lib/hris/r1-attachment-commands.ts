import {authorizeTuple} from './r1-authorization';
import {z} from 'zod';
import {HttpError} from './http';
import {commitCommand,replayCommand,securityStamp,sameStamp,type CommandIntent} from './r1-command';
import type {DevelopmentContext} from './development-repository';
const header=z.object({commandId:z.string().uuid(),idempotencyKey:z.string().min(1).max(100),expectedAuthorizationRevision:z.number().int().nonnegative(),expectedWriterEpoch:z.number().int().nonnegative(),expectedRecoveryEpoch:z.number().int().nonnegative()}).strict();
export function attachmentIntent(request:Request,ctx:DevelopmentContext,revision:number,action:string,payload:unknown):CommandIntent|null{
 const raw=request.headers.get('x-r1-command');if(!raw){if(ctx.member.securityStamp?.featuresEnabled)throw new HttpError(409,'附件办理需要新版命令凭据','CLIENT_UPGRADE_REQUIRED');return null;}if(raw.length>2048)throw new HttpError(413,'命令凭据过长','BODY_TOO_LARGE');let h;try{h=header.parse(JSON.parse(raw));}catch{throw new HttpError(400,'附件命令凭据无效','INVALID_INPUT');}return {...h,action,payload,expectedWorkspaceRevision:revision};
}
export async function reserveUpload(ctx:DevelopmentContext,id:string,objectKey:string,metadataDigest:string,orgId:string){
 const {db,member:m}=ctx,stamp=await securityStamp(db,m.tenantId);if(!m.securityStamp||!sameStamp(stamp,m.securityStamp))throw new HttpError(409,'附件授权已变化','REVISION_CONFLICT');
 // Auxiliary orphan registry is not a business attachment and never grants access to bytes.
 await db.prepare("INSERT OR IGNORE INTO r1_object_upload_intents(tenant_id,id,actor_id,org_id,object_key,metadata_digest,created_at,workspace_revision,authorization_revision) SELECT w.owner,?,?,?,?,?,?,w.revision,s.authorization_revision FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner JOIN hris_memberships m ON m.tenant_id=w.owner WHERE w.owner=? AND w.revision=? AND s.open_gate=1 AND s.authorization_revision=? AND m.user_id=? AND m.active=1").bind(id,m.userId,orgId,objectKey,metadataDigest,new Date().toISOString(),m.tenantId,ctx.row.revision,stamp.authorizationRevision,m.userId).run();
 const row=await db.prepare('SELECT actor_id,metadata_digest,state FROM r1_object_upload_intents WHERE tenant_id=? AND id=?').bind(m.tenantId,id).first<any>();if(!row||row.actor_id!==m.userId||row.metadata_digest!==metadataDigest||row.state!=='reserved')throw new HttpError(409,'附件意图已变化或已冻结，请查询原记录','UPLOAD_INTENT_CONFLICT');
}
export async function replayAttachment(ctx:DevelopmentContext,intent:CommandIntent|null){return intent?replayCommand(ctx.db,ctx.member,ctx.member.securityStamp!,intent):null;}
export async function commitAttachment(ctx:DevelopmentContext,intent:CommandIntent,plan:(token:string)=>D1PreparedStatement[],result:Record<string,unknown>){return commitCommand(ctx.db,ctx.member,ctx.member.securityStamp!,intent,plan,result);}
/** Freeze the original workspace revision before attempting orphan compensation. Referenced bytes are never removed. */
export async function reconcileOrphan(ctx:DevelopmentContext,id:string,intent:CommandIntent,bucket:Pick<R2Bucket,'delete'>){
 const {db,member:m}=ctx,t=m.tenantId,u=await db.prepare('SELECT * FROM r1_object_upload_intents WHERE tenant_id=? AND id=? AND actor_id=?').bind(t,id,m.userId).first<any>();if(!u)throw new HttpError(404,'上传意图不可见','NOT_FOUND_OR_NOT_VISIBLE');
 if(m.securityStamp?.featuresEnabled)await authorizeTuple(db,m,{objectType:'BASE',action:'attachment.write',orgId:u.org_id,personId:'',field:'record',historyMode:'current'});else if(!['hr','admin'].includes(m.role))throw new HttpError(403,'没有附件维护权限','FORBIDDEN');
 const reference=await db.prepare('SELECT 1 FROM hris_attachments WHERE tenant_id=? AND id=?').bind(t,id).first();if(reference)return {id,state:'referenced',cleanupPending:false};
 const previousReference=await db.prepare("SELECT 1 FROM r1_recovery_changes WHERE tenant_id=? AND table_name='hris_attachments' AND json_extract(row_key,'$.id')=? LIMIT 1").bind(t,id).first();if(previousReference)return {id,state:'recovery_reference_retained',cleanupPending:true};
 const stamp=await securityStamp(db,t);await commitCommand(db,m,stamp,intent,token=>[
 db.prepare('INSERT INTO r1_adapter_guard SELECT owner,?,CASE WHEN NOT EXISTS(SELECT 1 FROM hris_attachments WHERE tenant_id=? AND id=?) THEN 1 ELSE 0 END FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(intent.commandId,t,id,t,token),
 db.prepare("UPDATE r1_object_upload_intents SET state='frozen_orphan' WHERE tenant_id=? AND id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)").bind(t,id,t,token),
 db.prepare("INSERT OR IGNORE INTO r1_object_cleanup(tenant_id,id,object_key,reason,state) SELECT owner,?,?,'unreferenced_upload','pending' FROM hris_workspaces WHERE owner=? AND last_mutation=?").bind(id,u.object_key,t,token),
 ],{id,state:'frozen_orphan',cleanupPending:true});
 try{await bucket.delete(u.object_key);}catch{return {id,state:'frozen_orphan',cleanupPending:true,physicalDelete:'failed'};}
 // No claim that queue bookkeeping completed; task 09 reconciles durable references and physical state.
 return {id,state:'frozen_orphan',cleanupPending:true,physicalDelete:'completed'};
}
