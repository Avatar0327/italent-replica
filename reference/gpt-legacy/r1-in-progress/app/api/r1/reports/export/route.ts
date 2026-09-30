import {reportContext} from '@/lib/hris/r1-report-context';
import {synchronousOrQueuedExport} from '@/lib/hris/r1-report-export';
import {reportCommandInput} from '@/lib/hris/r1-report-command-input';
import {json,failure,readBody} from '@/lib/hris/http';
export async function POST(request:Request){try{const body=reportCommandInput.parse(await readBody(request)),result=await synchronousOrQueuedExport(await reportContext(),{...body,payload:body.payload,action:'M32.export'});if(result.queued)return json(result,202);return new Response(result.bytes as Uint8Array<ArrayBuffer>,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="report.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-R1-Command-Id':body.commandId}});}catch(e){return failure(e);}}
