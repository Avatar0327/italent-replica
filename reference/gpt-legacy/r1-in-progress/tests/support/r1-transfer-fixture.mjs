import {setup,core,grant,hris,expect,act,request} from './foundation-scenario.mjs';
const {memberContext}=await import('../../lib/hris/context.ts');
const route=await import('../../app/api/r1/commands/route.ts');
const {businessDate}=await import('../../lib/hris/business-time.ts');
export async function transferFixture(t,withGrades=false){
 const f=await setup();t.after(()=>f.sqlite.close());
 await core({action:'position',code:'R1-B',name:'合成B岗',orgId:f.otherOrg.id,family:'技术',responsibilities:'R1合成',status:'启用'});
 let sourceGrade=null,targetGrade=null;if(withGrades){await core({action:'grade',code:'R1-G1',name:'级别一',sequence:1,status:'启用'});await core({action:'grade',code:'R1-G2',name:'级别二',sequence:2,status:'启用'});const s=(await expect(await hris.GET())).state;sourceGrade=s.grades.find(g=>g.code==='R1-G1');targetGrade=s.grades.find(g=>g.code==='R1-G2');}
 await core({action:'employee',...f.e,positionId:f.position.id,gradeId:sourceGrade?.id??null});
 await grant('r1-hr','hr',null,[f.org.id,f.otherOrg.id]);await grant('r1-b','approver',null,[f.otherOrg.id]);
 await core({action:'workflow',kind:'transfer',steps:[{userId:'approver',name:'来源审核'},{userId:'r1-b',name:'目标审核'}]});
 const ctx=await memberContext(),tenant=ctx.member.tenantId;f.tenant=tenant;
 const state=JSON.parse(ctx.row.data);f.target=state.positions.find(p=>p.code==='R1-B');
 for(const who of ['owner','r1-hr','approver','r1-b'])for(const action of ['request','decide','withdraw','executeTransfer','cancelTransfer','workflow']){
  const scopes=who==='approver'?[f.org.id]:who==='r1-b'?[f.otherOrg.id]:[f.org.id,f.otherOrg.id];
  f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(tenant,who+action,who,'M01','transfer.'+action,'scope',JSON.stringify(scopes),'["record","level"]','current','2020-01-01',null);
 }
 const seed=(id,kind,orgId,personId,payload,status='active')=>f.sqlite.prepare('INSERT INTO r1_m01_entities VALUES (?,?,?,?,?,?,?,?,?)').run(tenant,id,kind,personId,orgId,null,1,status,JSON.stringify(payload));f.seed=seed;
 for(const o of state.orgs)seed(o.id,'org',o.id,null,{name:o.name,parentId:o.parentId,validFrom:'2020-01-01',validTo:null,attributes:{}});
 for(const p of state.positions)seed(p.id,'position',p.orgId,null,{name:p.name,orgId:p.orgId,validFrom:'2020-01-01',validTo:null,attributes:{}});
 seed(f.e.id,'person',f.org.id,null,{name:f.e.name,code:f.e.code});seed('segment','employment',f.org.id,f.e.id,{startOn:'2026-01-01'});
 seed('primary','assignment',f.org.id,f.e.id,{type:'primary',employmentId:'segment',positionId:f.position.id,validFrom:'2026-01-01',validTo:null,occupancy:1});
 f.setViewLevel=async(who,value)=>{const {commitCommand}=await import('../../lib/hris/r1-command.ts');act('owner');const c=await memberContext(),s=c.member.securityStamp,id=crypto.randomUUID();await commitCommand(f.db,c.member,s,{commandId:id,idempotencyKey:id,action:'synthetic.fixture.fieldPermission',payload:{who,value},expectedWorkspaceRevision:c.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch},token=>[f.db.prepare('UPDATE hris_memberships SET view_level=? WHERE tenant_id=? AND user_id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(value,tenant,who,tenant,token)]);};
 if(withGrades)for(const who of ['r1-hr','approver','r1-b'])await f.setViewLevel(who,1);
 f.sqlite.exec('UPDATE r1_schema_state SET features_enabled=1');
 f.intent=async command=>{const c=await memberContext(),s=c.member.securityStamp,key=crypto.randomUUID();return {commandId:key,idempotencyKey:key,action:'M01.transfer',payload:{operation:'transfer',command},expectedWorkspaceRevision:c.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch};};
 f.post=async(command,status=200)=>expect(await route.POST(request('/api/r1/commands',await f.intent(command))),status);
 f.request={action:'request',kind:'transfer',employeeId:f.e.id,orgId:f.otherOrg.id,positionId:f.target.id,effectiveOn:businessDate(),intent:'independent',...(targetGrade?{gradeId:targetGrade.id}:{}),reason:'合成独立调动事项'};
 f.submit=async extra=>{act('r1-hr');return (await f.post({...f.request,...extra})).result.approvalId;};
 f.approve=async id=>{act('approver');await f.post({action:'decide',id,decision:'approved'});act('r1-b');await f.post({action:'decide',id,decision:'approved'});};
 f.state=async()=>JSON.parse((await memberContext()).row.data);
 f.snapshot=()=>['hris_workspaces','hris_employees','hris_approvals','hris_approval_steps','r1_m01_entities','r1_m01_versions','r1_occupancy_events','r1_commands','r1_outbox','hris_employment_history','hris_audit_events'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 return f;
}
