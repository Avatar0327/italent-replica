import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Performance from './workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/performance');return <Performance/>;}
