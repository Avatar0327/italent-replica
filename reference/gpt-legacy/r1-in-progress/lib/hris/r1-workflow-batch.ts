import {z} from 'zod';
import {HttpError} from './http';
import {commitCommand,digest,sameStamp,securityStamp,type CommandIntent} from './r1-command';
import {executeWorkflow,workflowInput} from './r1-workflow';
import type {WorkflowAdapter} from './r1-workflow-adapters';
import type {memberContext} from './context';
const item=z.object({itemId:z.string().min(1).max(100),commandId:z.string().uuid(),payload:workflowInput}).strict().refine(i=>i.payload.operation==='decide','只允许批量审批');
export const workflowBatchInput=z.object({batchId:z.string().uuid(),items:z.array(item).min(1).max(20),expectedAuthorizationRevision:z.number().int(),expectedWriterEpoch:z.number().int(),expectedRecoveryEpoch:z.number().int()}).strict();
type Context=Awaited<ReturnType<typeof memberContext>>;
/** Every item commits independently. A lost response is recovered from its atomic item receipt. */
export async function executeWorkflowBatch(context:()=>Promise<Context>,input:unknown,registry?:Record<string,WorkflowAdapter>){
 const b=workflowBatchInput.parse(input);if(new Set(b.items.map(i=>i.itemId)).size!==b.items.length||new Set(b.items.map(i=>i.commandId)).size!==b.items.length)throw new HttpError(400,'批量条目编号重复','INVALID_BATCH');
 const first=await context(),t=first.member.tenantId,actor=first.member.userId,hash=await digest(b),db=first.db;
 const check=async(ctx:Context)=>{const s=await securityStamp(db,t);if(ctx.member.userId!==actor||ctx.member.tenantId!==t||!ctx.member.securityStamp||!sameStamp(s,ctx.member.securityStamp)||s.authorizationRevision!==b.expectedAuthorizationRevision||s.writerEpoch!==b.expectedWriterEpoch||s.recoveryEpoch!==b.expectedRecoveryEpoch)throw new HttpError(409,'批量请求授权版本变化','REVISION_CONFLICT');return s;};
 const make=(ctx:Context,id:string,action:string,payload:unknown):CommandIntent=>({commandId:id,idempotencyKey:id,action,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:b.expectedAuthorizationRevision,expectedWriterEpoch:b.expectedWriterEpoch,expectedRecoveryEpoch:b.expectedRecoveryEpoch});
 await check(first);const prior=await db.prepare('SELECT actor_id,digest FROM r1_workflow_batches WHERE tenant_id=? AND id=?').bind(t,b.batchId).first<{actor_id:string;digest:string}>();if(prior&&(prior.actor_id!==actor||prior.digest!==hash))throw new HttpError(409,'批量键内容冲突','BATCH_CONFLICT');
 if(!prior)await commitCommand(db,first.member,await check(first),make(first,b.batchId,'M19.batchBegin',{digest:hash}),token=>[db.prepare('INSERT INTO r1_workflow_batches SELECT owner,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(b.batchId,actor,hash,new Date().toISOString(),t,token)],{batchId:b.batchId});
 const results:Record<string,unknown>[]=[];
 for(const item of b.items){
  const ctx=await context();await check(ctx);const itemDigest=await digest(item),read=()=>db.prepare('SELECT request_digest,result FROM r1_workflow_batch_items WHERE tenant_id=? AND batch_id=? AND item_id=? AND actor_id=?').bind(t,b.batchId,item.itemId,actor).first<{request_digest:string;result:string}>();const old=await read();if(old){if(old.request_digest!==itemDigest)throw new HttpError(409,'条目键冲突','BATCH_CONFLICT');results.push({itemId:item.itemId,...JSON.parse(old.result),replayed:true});continue;}
  try{await executeWorkflow(ctx,make(ctx,item.commandId,'M19.decide',item.payload),registry,{batchId:b.batchId,itemId:item.itemId,requestDigest:itemDigest});results.push({itemId:item.itemId,...JSON.parse((await read())!.result)});}
  catch(e){const receipt=await read();if(receipt){results.push({itemId:item.itemId,...JSON.parse(receipt.result),recovered:true});continue;}
   if(!(e instanceof HttpError)||e.status>=500){results.push({itemId:item.itemId,status:'unknown',commandId:item.commandId});continue;}
   const safe={status:'rejected',beforeRevision:'expectedRevision' in item.payload?item.payload.expectedRevision:null,afterRevision:null,queryRef:'/api/r1/commands/'+item.commandId,machineCode:e.status===403||e.status===404?'NOT_ACTIONABLE':e.machineCode??'REJECTED',commandId:item.commandId},fresh=await context();
   await commitCommand(db,fresh.member,await check(fresh),make(fresh,item.commandId,'M19.batchRejected',{batchId:b.batchId,itemId:item.itemId,digest:itemDigest}),token=>[db.prepare('INSERT INTO r1_workflow_batch_items SELECT owner,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(b.batchId,item.itemId,actor,itemDigest,item.commandId,JSON.stringify(safe),t,token)],safe);results.push({itemId:item.itemId,...safe});
  }
 }
 return {batchId:b.batchId,items:results};
}
