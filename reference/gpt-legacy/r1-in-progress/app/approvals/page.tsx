import Link from 'next/link';
import HRIS from "@/app/hris";
import {requireChatGPTUser} from "@/app/chatgpt-auth";
export const dynamic="force-dynamic";
export default async function Page(){const user=await requireChatGPTUser("/approvals");return <><div className="p-3"><Link href="/r1-approvals">查看通用审批与待生效队列</Link></div><HRIS view="approvals" user={user.displayName}/></>;}
