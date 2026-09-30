import {z} from 'zod';
import {HttpError} from './http';
import {canonical,digest,commitCommand,securityStamp,sameStamp,type CommandIntent} from './r1-command';
import type {Member} from './authorization';
const id=z.string().min(1).max(100);
export const eventEnvelope=z.object({tenantId:id.optional(),schemaVersion:z.literal(1),eventId:id,eventType:id,source:id,internalId:id,externalId:id.nullable(),entityRevision:z.number().int().nonnegative(),workspaceRevision:z.number().int().nonnegative(),definitionVersion:id,sourceRevision:z.number().int().nonnegative(),sequence:z.number().int().positive(),mappingVersion:z.number().int().positive(),occurredAt:z.string().datetime({offset:true}),effectiveAt:z.string().datetime({offset:true}),correlationId:id,causationId:id,digestAlgorithm:z.literal('sha256-canonical-json-v1'),digest:z.string().regex(/^[a-f0-9]{64}$/),payload:z.object({approvalStatus:z.enum(['pending','approved','rejected','withdrawn','cancelled']).optional(),effectStatus:z.enum(['not_requested','waiting','waiting_external','applied','failed','cancelled','blocked']).optional(),nodeId:id.nullable().optional(),generation:z.number().int().positive().optional(),personId:id.optional(),assignmentVersionId:id.optional(),receiptId:id.optional(),state:z.enum(['sent','failed','unknown']).optional()}).strict()}).strict();
export type EventEnvelope=z.infer<typeof eventEnvelope>;
export type SourceContract={source:string;mappingVersion:number;schemaVersion:1;mode:'internal'|'simulated';version:string};
export async function makeEnvelope(input:Omit<EventEnvelope,'digest'>){const normalized={...input,occurredAt:new Date(input.occurredAt).toISOString(),effectiveAt:new Date(input.effectiveAt).toISOString()};return eventEnvelope.parse({...normalized,digest:await digest(normalized)});}
export async function verifyEnvelope(input:unknown,contract:SourceContract){
 const e=eventEnvelope.parse(input),{digest:claimed,...content}=e;
 if(e.source!==contract.source||e.mappingVersion!==contract.mappingVersion||e.schemaVersion!==contract.schemaVersion)throw new HttpError(409,'来源或映射版本不匹配','MAPPING_REQUIRED');
 const normalized={...content,occurredAt:new Date(content.occurredAt).toISOString(),effectiveAt:new Date(content.effectiveAt).toISOString()};
 if(await digest(normalized)!==claimed)throw new HttpError(409,'事件摘要不一致','DIGEST_CONFLICT');return {...normalized,digest:claimed};
}
export async function receiveEvent(db:D1Database,m:Member,intent:CommandIntent,input:unknown,contract:SourceContract,projection:(token:string,e:EventEnvelope)=>D1PreparedStatement[],consumerId='r1.compat'){
 id.parse(consumerId);
 const e=await verifyEnvelope(input,contract),tenant=m.tenantId;if(e.tenantId&&(contract.mode!=='internal'||e.tenantId!==tenant))throw new HttpError(403,'事件租户不匹配','TENANT_MISMATCH');
 if(!m.securityStamp||!sameStamp(m.securityStamp,await securityStamp(db,tenant)))throw new HttpError(409,'当前授权已变化','REVISION_CONFLICT');
 const prior=await db.prepare('SELECT digest,status FROM r1_consumer_inbox WHERE tenant_id=? AND consumer_id=? AND source=? AND event_id=?').bind(tenant,consumerId,e.source,e.eventId).first<{digest:string;status:string}>();
 if(prior){if(prior.digest!==e.digest){
 if(!m.securityStamp)throw new HttpError(409,'请读取当前授权');
 await commitCommand(db,m,m.securityStamp,intent,token=>[db.prepare('INSERT INTO r1_integration_quarantine(tenant_id,id,source,event_id,reason,digest) SELECT owner,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(crypto.randomUUID(),e.source,e.eventId,'EVENT_CONFLICT',e.digest,tenant,token)],{eventId:e.eventId,status:'quarantined',reasonCode:'EVENT_CONFLICT'});
 throw new HttpError(409,'同事件不同内容，已隔离核对','EVENT_CONFLICT');}return {status:'duplicate',eventId:e.eventId,mode:contract.mode};}
 const cursor=await db.prepare('SELECT sequence FROM r1_consumer_cursors WHERE tenant_id=? AND consumer_id=? AND source=? AND entity_id=?').bind(tenant,consumerId,e.source,e.internalId).first<{sequence:number}>();
 const expected=(cursor?.sequence??0)+1;
 if(e.sequence!==expected){const status=e.sequence>expected?'gap':'stale';await commitCommand(db,m,m.securityStamp,intent,token=>[db.prepare('INSERT INTO r1_integration_quarantine(tenant_id,id,source,event_id,reason,digest,owner_id,next_action,close_gate) SELECT owner,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(crypto.randomUUID(),e.source,e.eventId,status==='gap'?'SEQUENCE_GAP':'STALE_WITHOUT_RECEIPT',e.digest,m.userId,'reconcile_consumer:'+consumerId+':expected:'+expected,'consumer_consistency_acceptance',tenant,token)],{eventId:e.eventId,status,expectedSequence:expected});return {status,eventId:e.eventId,expectedSequence:expected,mode:contract.mode};}
 if(!m.securityStamp)throw new HttpError(409,'请读取当前授权');
 const result=await commitCommand(db,m,m.securityStamp,intent,token=>[
  ...projection(token,e),
  db.prepare('INSERT INTO r1_consumer_inbox SELECT owner,?,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(consumerId,e.source,e.eventId,e.sequence,e.internalId,e.digest,e.mappingVersion,new Date().toISOString(),'committed',tenant,token),
  db.prepare('INSERT INTO r1_consumer_cursors SELECT owner,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,consumer_id,source,entity_id) DO UPDATE SET sequence=excluded.sequence').bind(consumerId,e.source,e.internalId,e.sequence,tenant,token),
 ],{eventId:e.eventId,mode:contract.mode});return {...result,eventId:e.eventId,mode:contract.mode};
}
export const externalAdapters=['master_data','electronic_signing','assessment','budget','payment','notification'] as const;
export function adapterCatalog(){return externalAdapters.map(id=>({id,availability:'not_configured',executionMode:'disabled',realIntegration:'not_executed'}));}
export function requireExternalResult(kind:typeof externalAdapters[number],state:unknown):never{
 if(!externalAdapters.includes(kind))throw new HttpError(400,'适配领域无效');
 void state;throw new HttpError(503,'外部服务尚未配置；内部登记不代表外部完成','ADAPTER_NOT_CONFIGURED');
}
/** No network client is constructed here. Simulations require an explicit injected interceptor. */
export class SimulatedAdapter {
 readonly mode='simulated';readonly attempts:{id:string;digest:string}[]=[];private receipts=new Map<string,{digest:string;state:'sent'|'unknown'|'failed'}>();
 constructor(private interceptor:(id:string,payload:unknown)=>Promise<'sent'|'unknown'|'failed'>){}
 async send(id:string,payload:unknown){const d=await digest(payload),prior=this.receipts.get(id);if(prior){if(prior.digest!==d)throw new HttpError(409,'投递键内容冲突','IDEMPOTENCY_CONFLICT');return {mode:this.mode,...prior};}this.attempts.push({id,digest:d});const state=await this.interceptor(id,payload);this.receipts.set(id,{digest:d,state});return {mode:this.mode,digest:d,state};}
 query(id:string){return {mode:this.mode,...(this.receipts.get(id)??{state:'unknown'})};}
 receipt(id:string,payload:unknown,state:'sent'|'failed'){return digest(payload).then(d=>{const prior=this.receipts.get(id);if(prior&&prior.digest!==d)throw new HttpError(409,'回执摘要冲突','RECEIPT_CONFLICT');this.receipts.set(id,{digest:d,state});return this.query(id);});}
}
export function deliveryAction(state:string,recipientCurrent:boolean,sourceCurrent:boolean){
 if(state==='unknown')return 'query_receipt';if(!recipientCurrent||!sourceCurrent)return 'invalidate';if(state==='sent')return 'none';return 'send_if_configured';
}
export async function verifyCallback(body:unknown,signature:string,key:CryptoKey){
 if(!/^[a-f0-9]{64}$/.test(signature))throw new HttpError(403,'回调签名无效','INVALID_SIGNATURE');
 const bytes=Uint8Array.from(signature.match(/../g)!,h=>parseInt(h,16));
 if(!await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(canonical(body))))throw new HttpError(403,'回调签名无效','INVALID_SIGNATURE');
}
