import {HttpError} from './http';
import {authorizeTuple} from './r1-authorization';
import {workflowMember} from './r1-workflow';
import {commitCommand,digest,securityStamp} from './r1-command';
import type {memberContext} from './context';
type Context=Awaited<ReturnType<typeof memberContext>>;
export type SimulatedNotificationTransport={mode:'simulated';send:(id:string,payload:unknown)=>Promise<{state:'sent'|'failed'|'unknown';receiptId:string|null;digest:string}>;query:(id:string)=>Promise<{state:'sent'|'failed'|'unknown';receiptId:string|null;digest:string|null}>};
/** Explicitly injected simulation only. Production configuration and outbound dispatch are absent. */
export async function processWorkflowNotification(context:()=>Promise<Context>,id:string,transport?:SimulatedNotificationTransport){
 const ctx=await context(),{db,member:m}=ctx,t=m.tenantId,stamp=await securityStamp(db,t);if(!stamp.featuresEnabled)throw new HttpError(409,'新能力未开放','FEATURE_NOT_READY');
 const n=await db.prepare('SELECT * FROM r1_workflow_notifications WHERE tenant_id=? AND id=?').bind(t,id).first<any>();if(!n)throw new HttpError(404,'通知不存在','NOT_FOUND');const i=await db.prepare('SELECT * FROM r1_workflow_instances WHERE tenant_id=? AND id=?').bind(t,n.instance_id).first<any>();if(!i)throw new HttpError(409,'原流程不可用','SOURCE_UNAVAILABLE');
 await authorizeTuple(db,m,{objectType:'M19',action:'remind',orgId:i.org_id,personId:i.person_id,field:'record',historyMode:'current'});
 const payload={instanceId:n.instance_id,nodeId:n.node_id,nodeRevision:n.node_revision,recipientId:n.recipient_id,templateVersion:n.template_version},hash=await digest(payload);
 const update=async(state:string,receiptId:string|null,attempt:boolean,expectedState:string)=>{const fresh=await context(),s=await securityStamp(db,t),key=crypto.randomUUID();await authorizeTuple(db,fresh.member,{objectType:'M19',action:'remind',orgId:i.org_id,personId:i.person_id,field:'record',historyMode:'current'});return commitCommand(db,fresh.member,s,{commandId:key,idempotencyKey:key,action:'M19.notificationState',payload:{id,state,receiptId},expectedWorkspaceRevision:fresh.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch},token=>[db.prepare('INSERT INTO r1_workflow_commit_guard SELECT owner,?,CASE WHEN EXISTS(SELECT 1 FROM r1_workflow_notifications WHERE tenant_id=? AND id=? AND status=?) THEN 1 ELSE 0 END FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(key,t,id,expectedState,t,token),db.prepare('UPDATE r1_workflow_notifications SET status=?,provider_receipt_id=?,digest=?,attempt=attempt+? WHERE tenant_id=? AND id=? AND status=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(state,receiptId,hash,Number(attempt),t,id,expectedState,t,token)],{notificationId:id,state});};
 if(n.status==='sent'||n.status==='invalidated')return {state:n.status,action:'none',mode:'disabled'};
 if(!transport)return {state:n.status==='unknown'?'unknown':'not_configured',action:n.status==='unknown'?'query_receipt_unavailable':'none',mode:'disabled'};
 if(transport.mode!=='simulated')throw new HttpError(403,'本轮只允许显式模拟适配器','EXTERNAL_MODE_FORBIDDEN');
 if(n.status==='unknown'){
  const receipt=await transport.query(id);if(receipt.digest&&receipt.digest!==hash)throw new HttpError(409,'回执内容不一致','RECEIPT_CONFLICT');
  if(receipt.state!=='unknown'){if(!receipt.receiptId||!receipt.digest)throw new HttpError(409,'缺少可信回执','RECEIPT_REQUIRED');await update(receipt.state,receipt.receiptId,false,'unknown');}return {...receipt,action:'query_receipt',mode:'simulated'};
 }
 const node=await db.prepare('SELECT * FROM r1_workflow_nodes WHERE tenant_id=? AND id=?').bind(t,n.node_id).first<any>();let current=!!node&&node.status==='pending'&&node.revision===n.node_revision&&i.current_node_id===node.id&&JSON.parse(node.assignees).includes(n.recipient_id);
 try{const recipient=await workflowMember(db,t,n.recipient_id,stamp);for(const field of JSON.parse(i.template_payload).requiredFields)await authorizeTuple(db,recipient,{objectType:'M19',action:'decide',orgId:i.org_id,personId:i.person_id,field,historyMode:'current'});}catch(e){if(e instanceof HttpError&&e.status===403)current=false;else throw e;}
 if(!current){await update('invalidated',null,false,n.status);return {state:'invalidated',action:'invalidate',mode:'simulated'};}
 // Durable unknown before crossing the adapter boundary; a crash cannot create a send retry.
 const claim=await update('unknown',null,true,n.status);const currentContext=await context();if(currentContext.row.revision!==claim.workspaceRevision)throw new HttpError(409,'通知领取后原单变化，保留待查询','REVISION_CONFLICT');
 const latest=await securityStamp(db,t);if(latest.authorizationRevision!==stamp.authorizationRevision)throw new HttpError(409,'通知领取后权限变化，保留待查询','REVISION_CONFLICT');
 let receipt;try{receipt=await transport.send(id,payload);}catch{return {state:'unknown',action:'query_receipt',mode:'simulated'};}
 if(receipt.digest!==hash)throw new HttpError(409,'模拟回执摘要不一致','RECEIPT_CONFLICT');if(receipt.state!=='unknown'){if(!receipt.receiptId)throw new HttpError(409,'回执编号缺失','RECEIPT_REQUIRED');await update(receipt.state,receipt.receiptId,false,'unknown');}return {...receipt,action:'send',mode:'simulated'};
}
