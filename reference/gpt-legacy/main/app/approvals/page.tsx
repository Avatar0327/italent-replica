import HRIS from "@/app/hris";
import {requireChatGPTUser} from "@/app/chatgpt-auth";
export const dynamic="force-dynamic";
export default async function Page(){const user=await requireChatGPTUser("/approvals");return <HRIS view="approvals" user={user.displayName}/>;}
