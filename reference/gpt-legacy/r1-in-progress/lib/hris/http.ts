import { z } from 'zod';
import { AccessError } from './authorization';
export class HttpError extends Error {constructor(public status:number,message:string,public machineCode?:string){super(message);}}
export const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export function failure(e:unknown){if(e instanceof HttpError)return json({error:e.message,...(e.machineCode?{machineCode:e.machineCode}:{})},e.status);if(e instanceof AccessError)return json({error:e.message},403);if(e instanceof z.ZodError)return json({error:'请检查输入格式和必填信息'},400);return json({error:'操作暂时无法完成，请查询原命令状态',machineCode:'STORAGE_UNAVAILABLE',outcome:'unknown'},503);}
export async function readBody(request:Request,maxBytes=32768){
 if(request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'请求来源无效');
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new HttpError(415,'请求格式无效');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'请求为空');
 const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new HttpError(413,'请求内容过大');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(400,'请求格式无效');}
}
