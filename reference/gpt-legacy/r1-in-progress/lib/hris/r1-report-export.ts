import {z} from 'zod';
import {HttpError} from './http';
import {exportReportPage} from './r1-report-export-plan';
import {reportFence,type ReportContext} from './r1-report-context';
import {commitCommand,replayCommand,type CommandIntent} from './r1-command';
import {reportCsvChunk,byteDigest} from './r1-report-csv';
import {manageReportJob} from './r1-report-jobs';
const input=z.object({operation:z.literal('create'),id:z.string().min(1).max(100),query:z.record(z.string().max(12000))}).strict();
/** Retained small-file path: SQL pages remain bounded, file bytes <=8MiB; overflow queues a complete job. */
export async function synchronousOrQueuedExport(ctx:ReportContext,intent:CommandIntent){const c=input.parse(intent.payload);if(!c.query.generation&&!c.query.snapshot)throw new HttpError(400,'导出需固定已查询的数据版本或快照','GENERATION_REQUIRED');if(c.query.cursor)throw new HttpError(400,'导出不能从中间页开始','EXPORT_CURSOR_FORBIDDEN');const replay=await replayCommand(ctx.db,ctx.member,ctx.member.securityStamp!,intent);if(replay?.result?.jobId)return {queued:true,receipt:replay};const pinned={...c.query,...(replay?.result.definitionVersion?{definitionVersion:String(replay.result.definitionVersion)}:{})};let cursor:string|null=null,count=0,byteCount=0;const parts:Uint8Array[]=[];do{
 const page:any=await exportReportPage(ctx,pinned,cursor);if(page.reportDefinitionVersion)pinned.definitionVersion=String(page.reportDefinitionVersion);if(!page.generation)throw new HttpError(503,'数据版本尚不可用','PROJECTION_REQUIRED');const bytes=new TextEncoder().encode(reportCsvChunk(page.columns,page.rows,parts.length===0));if(bytes.byteLength>4*1024*1024)throw new HttpError(413,'CSV单块超过4MiB','EXPORT_CHUNK_TOO_LARGE');count+=page.rows.length;byteCount+=bytes.byteLength;
 if(count>10000||byteCount>8*1024*1024){if(replay)throw new HttpError(409,'原同步结果已不可重建','EXPORT_DIGEST_CONFLICT');return {queued:true,receipt:await manageReportJob(ctx,intent)};}parts.push(bytes);cursor=page.nextCursor;
 }while(cursor);const bytes=new Uint8Array(byteCount);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}const hash=await byteDigest(bytes);await reportFence(ctx);if(replay){if(replay.result.fileDigest!==hash)throw new HttpError(409,'当前权限下结果与原文件不一致','EXPORT_DIGEST_CONFLICT');}else await commitCommand(ctx.db,ctx.member,ctx.member.securityStamp!,intent,()=>[],{mode:'synchronous',definitionVersion:pinned.definitionVersion??null,fileDigest:hash,rows:count,bytes:byteCount,generation:c.query.generation??null,snapshot:c.query.snapshot??null});return {queued:false,bytes,rows:count,digest:hash};}
