import {z} from 'zod';
import {developmentContext} from '@/lib/hris/development-repository';
import {cadreProfile,cadreProfileKinds} from '@/lib/hris/cadre-profiles';
import {json,failure} from '@/lib/hris/http';
export async function GET(request:Request){try{const id=z.string().min(1).max(100).parse(new URL(request.url).searchParams.get('employeeId'));const ctx=await developmentContext(cadreProfileKinds,['admin','hr','manager']);return json(cadreProfile(ctx,id));}catch(e){return failure(e);}}
