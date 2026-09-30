import {z} from 'zod';
import {HttpError} from './http';
import {verifyCallback} from './r1-integration';
import {commitCommand,digest,securityStamp,type CommandIntent} from './r1-command';
import {authorizeTuple} from './r1-authorization';
import type {Member} from './authorization';
const id=z.string().min(1).max(100);
export const callbackBody=z.object({receiptId:id,deliveryId:id,payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['sent','failed']),externalState:z.enum(['sent','signed','paid','posted','failed']),nonce:id,timestamp:z.number().int().safe(),keyId:id}).strict();
export type CallbackContract={source:string;orgId:string;protocol:'r1-proxy-hmac-sha256-v1';mode:'simulated';keys:ReadonlyMap<string,CryptoKey>;windowMs:number;kind:'notification'|'payment'|'electronic_signing'|'assessment'|'master_data'|'budget'};
export async function acceptCallback(ctx:{db:D1Database;member:Member},intent:CommandIntent,body:unknown,signature:string,contract:CallbackContract){
 const {db,member:m}=ctx,t=m.tenantId,s=await securityStamp(db,t);await authorizeTuple(db,m,{objectType:'BASE',action:'integration.callback',orgId:contract.orgId,personId:'',field:'record',historyMode:'current'});
 const c=callbackBody.parse(body),hash=await digest(c),receiptHash=await digest({receiptId:c.receiptId,deliveryId:c.deliveryId,payloadDigest:c.payloadDigest,state:c.state,externalState:c.externalState});
 const quarantine=async(reason:string)=>{await commitCommand(db,m,s,intent,token=>[db.prepare('INSERT INTO r1_integration_quarantine(tenant_id,id,source,event_id,reason,digest,owner_id,next_action,close_gate) SELECT owner,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(crypto.randomUUID(),contract.source,c.receiptId,reason,hash,m.userId,'verify_original_provider_receipt','external_chain_acceptance',t,token)],{status:'quarantined',reasonCode:reason});throw new HttpError(409,'回调已隔离核对',reason);};
 const key=contract.keys.get(c.keyId);if(contract.protocol!=='r1-proxy-hmac-sha256-v1'||contract.mode!=='simulated'||!key||contract.windowMs<=0||contract.windowMs>300000)return quarantine('CALLBACK_PROTOCOL_UNAVAILABLE');
 try{await verifyCallback(c,signature,key);}catch{return quarantine('INVALID_SIGNATURE');}
 const states=contract.kind==='payment'?['sent','paid','posted','failed']:contract.kind==='electronic_signing'?['sent','signed','failed']:['sent','failed'];if(!states.includes(c.externalState)||(c.state==='failed')!==(c.externalState==='failed'))return quarantine('RECEIPT_STATE_MISMATCH');
 if(Math.abs(Date.now()-c.timestamp)>contract.windowMs)return quarantine('CALLBACK_EXPIRED');
 const nonce=await db.prepare('SELECT digest FROM r1_callback_nonces WHERE tenant_id=? AND source=? AND nonce=?').bind(t,contract.source,c.nonce).first<{digest:string}>();if(nonce&&nonce.digest!==hash)return quarantine('NONCE_REPLAY');
 const prior=await db.prepare('SELECT digest FROM r1_external_receipts WHERE tenant_id=? AND source=? AND receipt_id=?').bind(t,contract.source,c.receiptId).first<{digest:string}>();if(prior){if(prior.digest!==receiptHash)return quarantine('RECEIPT_CONFLICT');return {status:'duplicate',receiptId:c.receiptId,mode:'simulated'};}
 const d=await db.prepare('SELECT * FROM r1_provider_deliveries WHERE tenant_id=? AND id=? AND source_namespace=? AND org_id=?').bind(t,c.deliveryId,contract.source,contract.orgId).first<any>();if(!d||d.external_mode!=='simulated'||d.payload_digest!==c.payloadDigest)return quarantine('DELIVERY_REFERENCE_MISMATCH');if(d.receipt_id&&d.receipt_id!==c.receiptId)return quarantine('RECEIPT_REBIND_FORBIDDEN');
 return commitCommand(db,m,s,intent,token=>[
 db.prepare('INSERT INTO r1_adapter_guard SELECT owner,?,CASE WHEN abs((julianday(\'now\')-2440587.5)*86400000-?)<=? THEN 1 ELSE 0 END FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(intent.commandId,c.timestamp,contract.windowMs,t,token),
 db.prepare('INSERT INTO r1_callback_nonces SELECT owner,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(contract.source,c.nonce,hash,Date.now(),t,token),
 db.prepare('INSERT INTO r1_external_receipts SELECT owner,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(contract.source,c.receiptId,c.deliveryId,receiptHash,c.externalState,c.keyId,new Date().toISOString(),t,token),
 db.prepare('UPDATE r1_provider_deliveries SET state=?,receipt_id=?,receipt_digest=? WHERE tenant_id=? AND id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(c.state,c.receiptId,receiptHash,t,c.deliveryId,t,token),
 ],{receiptId:c.receiptId,state:c.state,externalState:c.externalState,mode:'simulated',businessEffect:'not_applied_by_callback'});
}
