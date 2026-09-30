import {HttpError} from './http';
import {digest} from './r1-command';
import {schemaObjects} from './r1-schema-manifest';
import {verifyRecoveryManifest,decryptRecoveryChunk,type SignedRecoveryManifest,recoveryVaultFor,type RecoveryVaultAccess,type ImmutableBackupStore} from './r1-recovery-crypto';
import {decodeRecoveryRecords,recoveryTables,recoverySchemaDigest,validateRecoveryRow,validateRecoveryTransaction,type RecoveryRow,type RecoveryTransaction} from './r1-recovery-data';
/** A separately provisioned, non-serving target. No default live-DB implementation exists. */
export interface IsolatedRecoveryTarget {
 readonly targetId:string;assertIsolated():Promise<void>;prepare(schema:typeof schemaObjects):Promise<void>;
 applyBaselineBatch(rows:RecoveryRow[],receipt:{id:string;digest:string}):Promise<void>;
 applyTransaction(tx:RecoveryTransaction,receipt:{id:string;digest:string}):Promise<void>;
 verifySourceCut(revisions:Record<string,number>,epochs?:Record<string,{schemaVersion:number;writerEpoch:number;recoveryEpoch:number;authorizationRevision:number}>):Promise<void>;
 finish():Promise<{integrity:string;foreignKeyErrors:number;openGate:0;outboundEnabled:false}>;
}
export async function restoreRecoveryDatabase(packages:SignedRecoveryManifest[],vault:RecoveryVaultAccess,store:ImmutableBackupStore,target:IsolatedRecoveryTarget,beforeSeal?:(target:IsolatedRecoveryTarget)=>Promise<void>){if(!packages.length)throw new HttpError(400,'恢复清单为空','RECOVERY_MANIFEST_INVALID');await target.assertIsolated();const schemaDigest=await recoverySchemaDigest();let prior:SignedRecoveryManifest|null=null;for(const value of packages){const signed=await verifyRecoveryManifest(value,vault,store),m=signed.manifest;if(m.schemaDigest!==schemaDigest)throw new HttpError(409,'恢复源码schema不支持此清单','RECOVERY_SCHEMA_UNSUPPORTED');if(!prior&&m.kind!=='baseline'||prior&&(m.kind!=='incremental'||m.parentCheckpoint!==prior.manifest.checkpointId||m.parentDigest!==prior.digest||m.fromSeq!==prior.manifest.toSeq))throw new HttpError(409,'恢复点基线/增量依赖不连续','RECOVERY_DEPENDENCY_MISSING');prior=signed;}
 await target.prepare(schemaObjects);const receipts:string[]=[];let restoredTransactions=0;
 for(const signed of packages){const m=signed.manifest,key=await recoveryVaultFor(vault,m.keyId).unwrapDataKey(m.wrappedKey),kind=m.kind==='baseline'?'baseline':'increment',chunks=m.chunks.filter(c=>c.kind===kind),records=decodeRecoveryRecords((async function*(){for(const c of chunks){const bytes=await store.get(c.key);if(!bytes)throw new HttpError(409,'已核验恢复块丢失','RECOVERY_OBJECT_MISSING');yield await decryptRecoveryChunk(m.checkpointId,key,c,bytes);}})());
  if(m.kind==='baseline'){const counts:Record<string,number>=Object.fromEntries(recoveryTables.map(t=>[t.name,0]));let batch:RecoveryRow[]=[],sequence=0;const flush=async()=>{if(!batch.length)return;const receipt={id:m.checkpointId+':baseline:'+sequence++,digest:await digest(batch)};await target.assertIsolated();await target.applyBaselineBatch(batch,receipt);receipts.push(receipt.id);batch=[];};for await(const row of records){validateRecoveryRow(row);counts[row.table]++;batch.push(row);if(batch.length===50)await flush();}await flush();if(await digest(counts)!==await digest(m.tableCounts))throw new HttpError(409,'恢复表逐行数量清单不匹配','RECOVERY_ROW_COUNT_MISMATCH');
  }else{let next=m.fromSeq+1;for await(const tx of records){validateRecoveryTransaction(tx,next);const receipt={id:m.checkpointId+':tx:'+tx.txId,digest:await digest(tx)};await target.assertIsolated();await target.applyTransaction(tx,receipt);next=tx.toSeq+1;receipts.push(receipt.id);restoredTransactions++;}if(next!==m.toSeq+1)throw new HttpError(409,'增量末尾事务缺失','RECOVERY_LOG_GAP');}
 }
 await target.verifySourceCut(packages.at(-1)!.manifest.tenantRevisions,packages.at(-1)!.manifest.tenantEpochs);if(beforeSeal)await beforeSeal(target);const result=await target.finish();return {targetId:target.targetId,checkpointId:packages.at(-1)!.manifest.checkpointId,receipts,restoredTransactions,...result,state:'database_restored_isolated',objectsRestored:false,authorizationReconciled:false,ownerApproved:false};
}
