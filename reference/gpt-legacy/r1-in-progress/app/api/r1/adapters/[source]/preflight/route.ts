import {z} from 'zod';
import {memberContext} from '@/lib/hris/context';
import {authorizeTuple} from '@/lib/hris/r1-authorization';
import {externalPayloads} from '@/lib/hris/r1-adapter-contracts';
import {digest} from '@/lib/hris/r1-command';
import {json,failure,readBody} from '@/lib/hris/http';
export async function POST(request:Request,{params}:{params:Promise<{source:string}>}){try{
 const source=z.enum(['master_data','electronic_signing','assessment','budget','payment','notification']).parse((await params).source),b=z.object({orgId:z.string().min(1).max(100),payload:z.unknown()}).strict().parse(await readBody(request)),ctx=await memberContext();
 await authorizeTuple(ctx.db,ctx.member,{objectType:'BASE',action:'integration.preflight',orgId:b.orgId,personId:'',field:'record',historyMode:'current'});const payload=externalPayloads[source].parse(b.payload);
 return json({source,contractVersion:'r1-minimum-v1',payloadDigest:await digest(payload),schemaValid:true,availability:'not_configured',executionMode:'disabled',reasonCode:source==='master_data'?'MAPPING_REQUIRED':'ADAPTER_NOT_CONFIGURED',realIntegration:'not_executed',businessEffect:'none'});
 }catch(e){return failure(e);}}
