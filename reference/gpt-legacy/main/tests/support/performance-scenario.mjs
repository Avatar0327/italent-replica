import {expect,get,core,hris,act,request,grant} from './foundation-scenario.mjs';
export const performance=await import('../../app/api/performance/route.ts');
export const changes=await import('../../app/api/performance-changes/route.ts');
export const checkins=await import('../../app/api/performance-checkins/route.ts');
export async function post(api,path,command,status=200,revision){
 const current=revision??(await get()).revision;
 return expect(await api.POST(request(path,{revision:current,command})),status);
}
export const perf=(c,s,r)=>post(performance,'/api/performance',c,s,r);
export const change=(c,s,r)=>post(changes,'/api/performance-changes',c,s,r);
export const checkin=(c,s,r)=>post(checkins,'/api/performance-checkins',c,s,r);
export const goals=[{title:'交付质量',metric:'按照合成验收单逐项核对交付成果',weight:60},{title:'团队协作',metric:'按照合成分享记录核对协作成果',weight:40}];
export const revisedGoals=[{...goals[0],weight:70},{...goals[1],weight:30}];
export function cycleInput(orgId,period='H004-SYNTHETIC'){
 return {action:'cycle',orgId,period,name:'H004合成绩效周期',start:'2026-01-01',end:'2026-12-31',lowCut:60,highCut:80,lowLabel:'待改进',midLabel:'达成',highLabel:'优秀'};
}
export async function planFor(f,stage='confirmed',period='H004-SYNTHETIC'){
 act('owner');const cy=await perf(cycleInput(f.org.id,period));await perf({action:'startCycle',id:cy.id});
 act('employee');const p=await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals});
 if(stage==='draft')return {cy,p};
 act('manager');await perf({action:'confirmGoals',id:p.id});
 if(stage==='confirmed')return {cy,p};
 act('employee');await perf({action:'selfReview',id:p.id,evidence:'合成成果完整提交，供独立管理者评价'});
 if(stage==='submitted')return {cy,p};
 act('manager');await perf({action:'evaluate',id:p.id,scores:[60,70],evidence:'根据合成目标和成果材料独立评分'});
 if(stage==='evaluated')return {cy,p};
 act('owner');const result=await perf({action:'publishPerformance',id:p.id,evidence:'核对合成目标和评价快照后发布'});
 return {cy,p,result};
}
export async function moveEmployee(f,kind){
 act('owner');await grant('lifecycleApprover','approver',null,[f.org.id,f.otherOrg.id]);
 let positionId;
 if(kind==='transfer'){
  await core({action:'position',code:'H004-TARGET',name:'合成调入岗位',orgId:f.otherOrg.id,family:'测试',responsibilities:'合成验证',status:'启用'});
  positionId=(await expect(await hris.GET())).state.positions.find(p=>p.code==='H004-TARGET').id;
 }
 await core({action:'workflow',kind,steps:[{userId:'lifecycleApprover',name:'合成独立审批人'}]});
 await core({action:'request',kind,employeeId:f.e.id,orgId:kind==='transfer'?f.otherOrg.id:f.org.id,...(positionId?{positionId}:{}),reason:'合成绩效生命周期边界验证'});
 const pending=(await expect(await hris.GET())).state.approvals.find(p=>p.employeeId===f.e.id&&p.kind===kind&&p.status==='pending');
 act('lifecycleApprover');await core({action:'decide',id:pending.id,decision:'approved'});act('owner');
}
