import {requireChatGPTUser} from '@/app/chatgpt-auth';
import PersonnelWorkspace from './workspace';
export const dynamic='force-dynamic';
export default async function Page(){const user=await requireChatGPTUser('/r1-personnel');return <PersonnelWorkspace user={user.displayName}/>;}
