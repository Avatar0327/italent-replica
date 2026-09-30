import {memberContext} from '@/lib/hris/context';
import {migrateWorkspace} from '@/lib/hris/repository';
import {json,failure,readBody,HttpError} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{const body=await readBody(request);if(body?.action!=='migrate')throw new HttpError(400,'操作无效');const c=await memberContext(true);const changed=await migrateWorkspace(c.db,c.member,c.row);if(!changed&&c.row.storageVersion!==1)throw new HttpError(409,'数据或权限已更新，请刷新重试');return json({ok:true});}catch(e){return failure(e);}}
