import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Audit from './records';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/audit');return <Audit/>;}
