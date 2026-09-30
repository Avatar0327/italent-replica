import {z} from 'zod';
import {memberContext} from '@/lib/hris/context';
import {json,failure,readBody,HttpError} from '@/lib/hris/http';
import {executeWorkflow} from '@/lib/hris/r1-workflow';
import {executeR1Transfer} from '@/lib/hris/r1-transfer';
import {executeM01} from '@/lib/hris/r1-m01';
export const dynamic='force-dynamic';
const input=z.object({correlationId:z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/).optional(),causationId:z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/).optional(),commandId:z.string().uuid(),idempotencyKey:z.string().min(1).max(100),action:z.string().min(1).max(100),payload:z.unknown(),expectedWorkspaceRevision:z.number().int().nonnegative(),expectedAuthorizationRevision:z.number().int().nonnegative(),expectedWriterEpoch:z.number().int().nonnegative(),expectedRecoveryEpoch:z.number().int().nonnegative()}).strict();
export async function POST(request:Request){try{
 const b=input.parse(await readBody(request)),ctx=await memberContext();
 const operation=(b.payload as {operation?:string}|null)?.operation;
 if(operation&&b.action==='M19.'+operation)return json(await executeWorkflow(ctx,{...b,payload:b.payload}));
 if(!operation||b.action!=='M01.'+operation)throw new HttpError(400,'命令动作与载荷不匹配','UNKNOWN_COMMAND');
 if(operation==='transfer')return json(await executeR1Transfer(ctx,{...b,payload:b.payload}));
 return json(await executeM01(ctx,{...b,payload:b.payload}));
}catch(e){return failure(e);}}
