import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Result from './result';
export default async function Page({params}:{params:Promise<{id:string}>}){await requireChatGPTUser('/reports');return <Result id={(await params).id}/>;}
