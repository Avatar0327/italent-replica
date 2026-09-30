import Link from 'next/link';
import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Workspace from '../development/workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/learning');return <><div className="px-6 pt-4"><Link href="/learning-plans">学习计划配置与版本</Link></div><Workspace mode="learning"/></>;}
