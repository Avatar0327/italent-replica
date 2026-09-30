import {z} from 'zod';
import {HttpError} from './http';
import {digest,canonical} from './r1-command';
import type {SecuritySigner} from './r1-security-ledger';
export const recoveryReceiptSchemaSql=`CREATE TABLE recovery_external_receipts(tenant_id TEXT NOT NULL,channel TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(tenant_id,channel,intent_id));`;
const receiptSchema=z.object({purpose:z.literal('r1-recovery-external-receipt-v1'),tenant:z.string().min(1),channel:z.enum(['provider','workflow','subscription']),intentId:z.string().min(1),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),receiptId:z.string().min(1),state:z.literal('sent'),observedAt:z.number().int().nonnegative(),mode:z.literal('simulated')}).strict();
export type RecoveryExternalReceipt=z.infer<typeof receiptSchema>;
/** Only explicit simulation is connected in R1 P3. Actual provider receipt storage remains a platform contract. */
export class SqlRecoveryReceiptStore {
 constructor(private db:D1Database,private signer:SecuritySigner,storageId:string,businessStorageId:string){if(storageId===businessStorageId)throw new HttpError(409,'外效回执必须独立保存','RECOVERY_CONTROL_NOT_INDEPENDENT');}
 async record(value:RecoveryExternalReceipt){const r=receiptSchema.parse(value),existing=await this.lookup(r.tenant,r.channel,r.intentId);if(existing){if(existing.payloadDigest!==r.payloadDigest||existing.receiptId!==r.receiptId)throw new HttpError(409,'外效回执键或内容冲突','RECOVERY_RECEIPT_CONFLICT');return existing;}const hash=await digest(r),signature=await this.signer.sign(new TextEncoder().encode(hash));await this.db.prepare('INSERT INTO recovery_external_receipts VALUES (?,?,?,?,?,?)').bind(r.tenant,r.channel,r.intentId,canonical(r),hash,signature).run();return r;}
 async lookup(tenant:string,channel:RecoveryExternalReceipt['channel'],intentId:string){const row=await this.db.prepare('SELECT payload,digest,signature FROM recovery_external_receipts WHERE tenant_id=? AND channel=? AND intent_id=?').bind(tenant,channel,intentId).first<{payload:string;digest:string;signature:string}>();if(!row)return null;const r=receiptSchema.parse(JSON.parse(row.payload));if(r.tenant!==tenant||r.channel!==channel||r.intentId!==intentId||await digest(r)!==row.digest||!await this.signer.verify(new TextEncoder().encode(row.digest),row.signature))throw new HttpError(503,'独立外效回执认证失败','RECOVERY_RECEIPT_UNTRUSTED');return r;}
}
