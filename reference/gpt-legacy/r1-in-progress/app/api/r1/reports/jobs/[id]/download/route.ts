import {reportContext} from '@/lib/hris/r1-report-context';
import {downloadReportChunk} from '@/lib/hris/r1-report-jobs';
import {reportObjectStore} from '@/lib/hris/r1-report-runtime';
import {failure,HttpError} from '@/lib/hris/http';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
 const search=new URL(request.url).searchParams;if([...search.keys()].some(k=>k!=='part'))throw new HttpError(400,'未知下载参数','INVALID_INPUT');const id=(await params).id,part=search.has('part')?Number(search.get('part')):null;if(part!==null&&(!Number.isSafeInteger(part)||part<1))throw new HttpError(400,'分块编号无效','INVALID_INPUT');const store=reportObjectStore(),first=await downloadReportChunk(await reportContext(),id,part??1,store);let next=2;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(first.bytes);if(part!==null||first.manifest.chunks.length===1)controller.close();},async pull(controller){try{if(next>first.manifest.chunks.length)return;const current=await downloadReportChunk(await reportContext(),id,next,store);controller.enqueue(current.bytes);next++;if(next>first.manifest.chunks.length)controller.close();}catch(error){controller.error(error);}}});
 return new Response(stream,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="report.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
 }catch(e){return failure(e);}}
