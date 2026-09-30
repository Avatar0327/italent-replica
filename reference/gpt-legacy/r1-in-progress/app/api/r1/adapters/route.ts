import {memberContext} from '@/lib/hris/context';
import {adapterCatalog} from '@/lib/hris/r1-integration';
import {json,failure} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(){try{await memberContext();return json({adapters:adapterCatalog()});}catch(e){return failure(e);}}
