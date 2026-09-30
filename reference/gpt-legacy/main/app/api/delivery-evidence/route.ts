import {getChatGPTUser} from '@/app/chatgpt-auth';
import evidence from '@/lib/delivery/evidence.json';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'no-store'};
 if(!await getChatGPTUser())return Response.json({error:'请先登录'},{status:401,headers});
 return Response.json({generatedAt:evidence.generatedAt},{headers});
}
