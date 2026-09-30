import {reportContext} from '@/lib/hris/r1-report-context';
import {projectReport} from '@/lib/hris/r1-report-projection';
import {reportProducers} from '@/lib/hris/r1-report-m01-producer';
import {reportCommandInput} from '@/lib/hris/r1-report-command-input';
import {json,failure,readBody} from '@/lib/hris/http';
export async function POST(request:Request){try{const body=reportCommandInput.parse(await readBody(request));return json(await projectReport(await reportContext(),{...body,payload:body.payload,action:'M32.projection'},reportProducers()));}catch(e){return failure(e);}}
