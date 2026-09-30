import {memberContext} from '@/lib/hris/context';
import PersonnelWorkspace from '@/app/r1-personnel/workspace';
import HRIS from "@/app/hris";
import {requireChatGPTUser} from "@/app/chatgpt-auth";
export const dynamic="force-dynamic";
export default async function Page(){const user=await requireChatGPTUser("/employees");const ctx=await memberContext();if(ctx.member.securityStamp?.featuresEnabled)return <PersonnelWorkspace user={user.displayName}/>;return <HRIS view="employees" user={user.displayName}/>;}
