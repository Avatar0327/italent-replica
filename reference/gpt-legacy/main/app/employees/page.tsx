import HRIS from "@/app/hris";
import {requireChatGPTUser} from "@/app/chatgpt-auth";
export const dynamic="force-dynamic";
export default async function Page(){const user=await requireChatGPTUser("/employees");return <HRIS view="employees" user={user.displayName}/>;}
