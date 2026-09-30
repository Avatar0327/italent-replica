import {memberContext} from '@/lib/hris/context';
import {migrationApprovalCompatibility} from '@/lib/hris/r1-migration-compatibility';
import {json,failure,HttpError} from '@/lib/hris/http';
export async function GET(request:Request){try{const id=new URL(request.url).searchParams.get('id');if(!id||id.length>100)throw new HttpError(400,'原单ID无效','INVALID_INPUT');return json(await migrationApprovalCompatibility(await memberContext(),id));}catch(e){return failure(e);}}
