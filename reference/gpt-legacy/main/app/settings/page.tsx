import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Members from './members';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/settings');return <Members/>;}
