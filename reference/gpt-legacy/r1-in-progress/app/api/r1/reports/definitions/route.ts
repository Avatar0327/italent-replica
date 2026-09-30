import {reportContext} from '@/lib/hris/r1-report-context';
import {manageReportDefinition} from '@/lib/hris/r1-report-definition-service';
import {reportCommandInput} from '@/lib/hris/r1-report-command-input';
import {json,failure,readBody} from '@/lib/hris/http';
export async function POST(request:Request){try{const body=reportCommandInput.parse(await readBody(request));return json(await manageReportDefinition(await reportContext(),{...body,payload:body.payload,action:'M32.definition'}));}catch(e){return failure(e);}}
