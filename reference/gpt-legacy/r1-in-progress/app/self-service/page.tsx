import {requireChatGPTUser} from '@/app/chatgpt-auth';
import {memberContext} from '@/lib/hris/context';
import SelfService from './workspace';
import Portal from './r1-workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/self-service');const ctx=await memberContext();return ctx.member.securityStamp?.featuresEnabled?<Portal/>:<SelfService/>;}
