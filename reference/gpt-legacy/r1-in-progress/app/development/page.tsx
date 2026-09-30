import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Workspace from './workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/development');return <Workspace mode="talent"/>;}
