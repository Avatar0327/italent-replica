import {memberContext} from '@/lib/hris/context';
import {commandReceipt} from '@/lib/hris/r1-command';
import {json,failure} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{commandId:string}>}){try{
 const ctx=await memberContext(),{commandId}=await params;
 const receipt=await commandReceipt(ctx.db,ctx.member,commandId);
 return json(receipt??{commandId,status:'unknown',reasonCode:'NO_AUTHORITATIVE_RECEIPT'});
}catch(e){return failure(e);}}
