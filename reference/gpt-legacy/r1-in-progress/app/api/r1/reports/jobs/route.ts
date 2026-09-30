import {reportContext,reportFence} from '@/lib/hris/r1-report-context';
import {manageReportJob} from '@/lib/hris/r1-report-jobs';
import {reportCommandInput} from '@/lib/hris/r1-report-command-input';
import {json,failure,readBody,HttpError} from '@/lib/hris/http';
export async function POST(request:Request){try{const body=reportCommandInput.parse(await readBody(request));return json(await manageReportJob(await reportContext(),{...body,payload:body.payload,action:'M32.export'}));}catch(e){return failure(e);}}
export async function GET(request:Request){try{if(new URL(request.url).search)throw new HttpError(400,'不支持的任务列表参数','INVALID_INPUT');const ctx=await reportContext(),rows=(await ctx.db.prepare('SELECT id,status,runtime_state AS runtimeState,revision,reason_code AS reasonCode,created_at AS createdAt,expires_at AS expiresAt FROM r1_report_jobs WHERE tenant_id=? AND requester_id=? ORDER BY created_at DESC,id LIMIT 51').bind(ctx.member.tenantId,ctx.member.userId).all()).results;await reportFence(ctx);return json({jobs:rows.slice(0,50),hasMore:rows.length>50,limit:50});}catch(e){return failure(e);}}
