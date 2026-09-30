import {portalEntries,entryLabels} from './r1-portal-contract';
import {portalContext,readPortal} from './r1-portal';
import {portalLegacyContext} from './r1-portal-adapters';
import {legacySelfService} from './r1-legacy-self-service';
import {authorizeTuple} from './r1-authorization';
import {HttpError} from './http';
import {securityStamp,sameStamp} from './r1-command';
import type {memberContext} from './context';
export async function portalSummary(context:Awaited<ReturnType<typeof memberContext>>){
 const ctx=await portalContext(context),stamp=context.member.securityStamp!;if(!ctx)return {version:'r1',availability:'unavailable',reasonCode:'binding_missing',employee:null,entries:portalEntries.map(entry=>({entry,label:entryLabels[entry],availability:'unavailable'})),supplementaryTasks:[],payslipCount:null,revision:context.row.revision,securityStamp:stamp};
 const entries=[];for(const entry of portalEntries){const r=await readPortal(ctx,new URLSearchParams({entry}));entries.push({entry,label:entryLabels[entry],availability:r.availability,reasonCode:r.reasonCode,visibleTotal:r.visibleTotal,totalState:r.totalState,mode:'mode'in r?r.mode:null,counts:r.counts});}
 const legacy=await portalLegacyContext(ctx),old=legacySelfService(legacy),supplementaryTasks:any[]=[];
 for(const task of old.tasks.filter(t=>['feedbackInvite','surveyRound','onboardingPlan','cadreObservation'].includes(t.kind))){const source=legacy.records.find(r=>r.id===task.id);if(!source||source.employeeId!==ctx.personId)continue;try{await authorizeTuple(ctx.db,ctx.member,{objectType:'M48',action:'auxiliary.read',orgId:ctx.personOrgId,personId:ctx.personId,field:'record',historyMode:'current'});}catch(e){if(e instanceof HttpError&&e.status===403)continue;throw e;}supplementaryTasks.push({businessId:task.id,businessType:task.kind,producerId:task.kind==='feedbackInvite'?'M26':'legacy.'+task.kind,title:task.title,due:task.due,href:task.href,sourceVersion:source.updatedAt,sourceRevision:ctx.row.revision,mode:'compatibility',realIntegration:'not_executed',allowedActions:[]});}
 let payslipCount:number|null=null;try{await authorizeTuple(ctx.db,ctx.member,{objectType:'M48',action:'summary.read',orgId:ctx.personOrgId,personId:ctx.personId,field:'payslipCount',historyMode:'current'});payslipCount=old.payslipCount;}catch(e){if(!(e instanceof HttpError&&e.status===403))throw e;}
 if(!sameStamp(stamp,await securityStamp(ctx.db,ctx.member.tenantId))||(await ctx.db.prepare('SELECT revision FROM hris_workspaces WHERE owner=?').bind(ctx.member.tenantId).first<{revision:number}>())?.revision!==ctx.row.revision)throw new HttpError(409,'自助汇总版本已变化','REVISION_CONFLICT');
 return {version:'r1',availability:'available',stableEmployeeId:ctx.personId,entries,supplementaryTasks,payslipCount,payslipCountMeaning:'current member published non-cancelled payslip count; not amount or payments',revision:ctx.row.revision,securityStamp:stamp};
}
