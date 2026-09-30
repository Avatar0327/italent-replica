import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Attendance from './workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/attendance');return <Attendance/>;}
