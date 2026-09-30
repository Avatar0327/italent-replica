import type {CommandIntent,SecurityStamp} from './r1-command';
export type ClientStamp={revision:number;securityStamp:SecurityStamp};
/** Caller retains this object in memory until a receipt resolves an unknown outcome. Never regenerate on retry. */
export function clientIntent(stamp:ClientStamp,operation:string,payload:unknown):CommandIntent{
 const id=crypto.randomUUID();return {commandId:id,idempotencyKey:id,action:'M01.'+operation,payload,expectedWorkspaceRevision:stamp.revision,expectedAuthorizationRevision:stamp.securityStamp.authorizationRevision,expectedWriterEpoch:stamp.securityStamp.writerEpoch,expectedRecoveryEpoch:stamp.securityStamp.recoveryEpoch};
}
export async function sendClientCommand(intent:CommandIntent,transport:typeof fetch=fetch){
 try{const response=await transport('/api/r1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(intent),cache:'no-store'});const body=await response.json() as {error?:string;status?:string;commandId?:string};
  if(response.status>=500)return {state:'unknown' as const,commandId:intent.commandId,message:'结果尚未确认，请查询原办理记录'};
  if(!response.ok)return {state:'rejected' as const,status:response.status,message:body.error??'办理未提交'};
  return {state:'committed' as const,receipt:body};
 }catch{return {state:'unknown' as const,commandId:intent.commandId,message:'连接中断，结果尚未确认'};}
}
export async function queryClientCommand(commandId:string,transport:typeof fetch=fetch){
 const response=await transport('/api/r1/commands/'+encodeURIComponent(commandId),{cache:'no-store'}),body=await response.json() as {error?:string;status?:string;receipt?:{status?:string}};
 if(!response.ok)throw Error(body.error??'暂时无法核对办理结果');
 const receipt=body.receipt??body;return receipt.status==='committed'?{state:'committed' as const,receipt}:{state:'unknown' as const,commandId};
}
