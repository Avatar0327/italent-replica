import {env} from 'cloudflare:workers';
import {migrationContext} from '@/lib/hris/r1-migration-context';
import {verifyMigrationAttachments} from '@/lib/hris/r1-migration-attachments';
import {reportCommandInput} from '@/lib/hris/r1-report-command-input';
import {json,failure,readBody,HttpError} from '@/lib/hris/http';
export async function POST(request:Request){try{const body=reportCommandInput.parse(await readBody(request)),ctx=await migrationContext(),bucket=(env as unknown as {BUCKET?:R2Bucket}).BUCKET;if(!bucket)throw new HttpError(503,'附件对象适配器未配置','OBJECT_STORE_UNAVAILABLE');return json(await verifyMigrationAttachments(ctx,{...body,payload:body.payload,action:'BASE.migration.verifyAttachments'},{get:async key=>{const object=await bucket.get(key);if(!object)return null;if(object.size>10*1024*1024)throw new HttpError(413,'附件超过安全预算','ATTACHMENT_SIZE_BUDGET');return new Uint8Array(await object.arrayBuffer());}}));}catch(e){return failure(e);}}
