import {reportContext} from '@/lib/hris/r1-report-context';
import {readReport} from '@/lib/hris/r1-report-query';
import {json,failure} from '@/lib/hris/http';
export async function GET(request:Request){try{return json(await readReport(await reportContext(),new URL(request.url).searchParams));}catch(e){return failure(e);}}
