import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Recruitment from './workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/recruitment');return <Recruitment/>;}
