import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Catalogs from './catalogs';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/positions');return <Catalogs/>;}
