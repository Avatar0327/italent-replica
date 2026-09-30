import {database,act,request} from './support/runtime.mjs';
import {readdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {executeM01,m01Entity,tenure}=await import('../lib/hris/r1-m01.ts');
const {memberContext}=await import('../lib/hris/context.ts');
const {businessDate}=await import('../lib/hris/business-time.ts');
const access=await import('../app/api/access/route.ts');
const today=businessDate(),past='2020-01-01';
async function fixture(){
 const {sqlite,db}=database();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
 globalThis.p2env.DB=db;act('owner');assert.equal((await access.POST(request('/api/access',{action:'setup',name:'M01隔离合成企业'}))).status,200);
 const c=await memberContext(),tenant=c.member.tenantId;
 // Fixture setup precedes tested commands; never use an existing/production DB.
 sqlite.exec('DROP TRIGGER r1_guard_hris_orgs_insert; DROP TRIGGER r1_guard_hris_memberships_insert');
 sqlite.prepare("INSERT INTO hris_orgs(tenant_id,id,name,city,leader,status) VALUES (?,'A','合成A','上海','','启用'),(?,'B','合成B','上海','','启用')").run(tenant,tenant);
 sqlite.prepare("INSERT INTO hris_memberships(user_id,tenant_id,role,org_scope,view_email,view_level,active) VALUES ('reviewer',?,'hr','[\"A\",\"B\"]',1,1,1)").run(tenant);
 for(const who of ['owner','reviewer'])for(const op of ['catalog','identityReview','identityBind','contractField','person','employment','assignmentRequest','assignmentApprove','assignmentCancel','exitCancel','assignmentExecute','exitRequest','exitApprove','exitExecute','exitCleanup','contract','contractSign','contractEnd','template','subsetImport']){
  sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(tenant,who+op,who,'M01',op,'scope','["A","B"]','["record","name","email","skill"]','current',past,null);
 }
 sqlite.exec('UPDATE r1_schema_state SET features_enabled=1');
 function seed(id,kind,orgId,personId,payload,status='active',code=null){sqlite.prepare('INSERT INTO r1_m01_entities VALUES (?,?,?,?,?,?,?,?,?)').run(tenant,id,kind,personId,orgId,code,1,status,JSON.stringify(payload));sqlite.prepare('INSERT INTO r1_m01_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(tenant,id,1,0,'fixture',new Date().toISOString(),payload.validFrom??null,payload.validTo??null,'known',JSON.stringify({id,kind,personId,orgId,code,revision:1,status,payload}));}
 seed('A','org','A',null,{name:'合成A',parentId:'',validFrom:past,validTo:null,attributes:{}},'active','A');seed('B','org','B',null,{name:'合成B',parentId:'',validFrom:past,validTo:null,attributes:{}},'active','B');
 seed('position-a','position','A',null,{name:'岗位',orgId:'A',validFrom:past,validTo:null,attributes:{}},'active','PA');seed('position-b','position','B',null,{name:'岗位',orgId:'B',validFrom:past,validTo:null,attributes:{}},'active','PB');
 seed('person','person','A',null,{name:'合成人员'},'active','E1');seed('review','identity_review','A','person',{},'confirmed');
 const send=async(payload,key=crypto.randomUUID())=>{const ctx=await memberContext(),s=ctx.member.securityStamp;return executeM01(ctx,{commandId:key,idempotencyKey:key,action:'M01.'+payload.operation,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch});};
 return {sqlite,db,tenant,send,seed};
}
test('P3-M01-01: same org overlapping position name rejects, cross org permits, future cycles reject',async()=>{
 const f=await fixture(),base={operation:'catalog',kind:'position',code:'P2',name:'岗位',orgId:'A',parentId:'',status:'active',validFrom:today,validTo:null,attributes:{}};
 await assert.rejects(f.send(base),/名称冲突/);await f.send({...base,orgId:'B',name:'另一岗位'});
 f.seed('future-b','org','A',null,{name:'未来乙旧版',parentId:'',validFrom:past,validTo:'2026-12-31',attributes:{}},'active','FB');
 f.seed('future-a','org','A',null,{name:'未来甲',parentId:'future-b',validFrom:'2027-01-01',validTo:null,attributes:{}},'active','FA');
 await assert.rejects(f.send({operation:'catalog',id:'future-b',kind:'org',code:'FB',name:'未来乙',orgId:'A',parentId:'future-a',status:'active',validFrom:'2027-01-01',validTo:null,attributes:{}}),/环/);f.sqlite.close();
});
test('P3-M01-02: identity conflicts do not merge; stable rehire and tenure exclude gaps/internship',async()=>{
 const f=await fixture();await assert.rejects(f.send({operation:'identityReview',personId:'person',candidateIds:['person','other'],reason:'核验身份',evidenceRef:'synthetic-evidence'}),/冲突/);
 f.seed('ended','employment','A','person',{startOn:'2020-02-28',lastWorkingOn:'2020-03-01'},'ended');
 const r=await f.send({operation:'employment',personId:'person',orgId:'A',identityReviewId:'review',predecessorId:'ended',startOn:today,employmentType:'retired_rehire'});
 const e=await m01Entity(f.db,f.tenant,r.result.ids[0]);assert.equal(e.personId,'person');assert.equal(e.payload.accountRestored,false);
 assert.equal(tenure([{startOn:'2020-02-28',lastWorkingOn:'2020-03-01',status:'ended',employmentType:'employee'},{startOn:'2020-02-29',lastWorkingOn:'2020-03-01',status:'ended',employmentType:'employee'},{startOn:'2021-01-01',lastWorkingOn:'2021-01-10',status:'ended',employmentType:'internship'}],today).days,3);f.sqlite.close();
});
test('P3-M01-03: independent HR approves part time; it consumes zero additional headcount',async()=>{
 const f=await fixture();f.seed('employment','employment','A','person',{startOn:past},'active');f.seed('primary','assignment','A','person',{type:'primary',positionId:'position-a',validFrom:past,validTo:null,occupancy:1});
 let r=await f.send({operation:'assignmentRequest',personId:'person',employmentId:'employment',orgId:'B',positionId:'position-b',type:'part_time',homePrimaryId:'primary',validFrom:today,validTo:null,reviewerId:'reviewer',reason:'合成兼职申请'});const id=r.result.ids[0];
 await assert.rejects(f.send({operation:'assignmentApprove',id}),/审核角色/);act('reviewer');await f.send({operation:'assignmentApprove',id});act('owner');r=await f.send({operation:'assignmentExecute',id});
 assert.equal((await m01Entity(f.db,f.tenant,r.result.assignmentId)).payload.occupancy,0);assert.equal((await m01Entity(f.db,f.tenant,'primary')).payload.occupancy,1);f.sqlite.close();
});
test('P3-M01-07: legal scope, same legal ID and adjacent renewal dates; immutable versions',async()=>{
 const f=await fixture();f.seed('legal','legal_entity','A',null,{name:'法人旧名',validFrom:past,validTo:null,attributes:{orgIds:[]}},'active','LE');
 const c={operation:'contract',personId:'person',orgId:'A',legalEntityId:'legal',number:'C2',agreementCategory:'labor',contractType:'fixed',start:'2026-01-01',end:'2026-12-31',renewalOf:null,fields:{}};
 await assert.rejects(f.send(c),/范围/);f.seed('legal-scoped','legal_entity','A',null,{name:'法人旧名',validFrom:past,validTo:null,attributes:{orgIds:['A']}},'active','LE-S');c.legalEntityId='legal-scoped';
 f.seed('old-contract','contract','A','person',{legalEntityId:'legal-scoped',start:'2025-01-01',end:'2025-12-30'},'signed','C1');
 await assert.rejects(f.send({...c,renewalOf:'old-contract'}),/相邻日/);
 const r=await f.send({...c,start:'2025-12-31',renewalOf:'old-contract'});assert.equal((await m01Entity(f.db,f.tenant,r.result.ids[0])).payload.legalName,'法人旧名');
 assert.throws(()=>f.sqlite.exec('UPDATE r1_m01_versions SET payload=\'{}\''),/IMMUTABLE_HISTORY/);f.sqlite.close();
});
test('P3-M01-08: subset row key is idempotent across transport command IDs and explicit null survives',async()=>{
 const f=await fixture();const t=await f.send({operation:'template',orgId:'A',kind:'skill',entryType:'subset',fields:[{code:'skill',type:'text',required:false,default:'未配置',uniqueKey:false,readActions:['read'],writeActions:['update']}]});
 const p={operation:'subsetImport',personId:'person',orgId:'A',templateId:t.result.ids[0],templateVersion:1,batchId:'batch',rowNo:1,attemptVersion:1,mode:'create',recordId:null,fields:{skill:null}};
 const a=await f.send(p),b=await f.send(p);assert.deepEqual(a.result.ids,b.result.ids);assert.equal((await m01Entity(f.db,f.tenant,a.result.ids[0])).payload.fields.skill,null);f.sqlite.close();
});
test('P3-M01-09: missing or wrong entry template blocks person creation and never activates accounts',async()=>{
 const f=await fixture();const t=await f.send({operation:'template',orgId:'A',kind:'custom',entryType:'prehire',fields:[{code:'email',type:'text',required:true,default:null,uniqueKey:false,readActions:['read'],writeActions:['update']}]});
 const p={operation:'person',code:'P-new',name:'合成待入职',orgId:'A',templateId:t.result.ids[0],entryType:'prehire',fields:{}};await assert.rejects(f.send(p),/必填/);
 const before=f.sqlite.prepare('SELECT count(*) n FROM hris_memberships').get().n;const r=await f.send({...p,fields:{email:'fixture@example.invalid'}});assert.equal((await m01Entity(f.db,f.tenant,r.result.ids[0])).payload.invite,false);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM hris_memberships').get().n,before);f.sqlite.close();
});
async function retainedOriginCommand(payload){
 const ctx=await memberContext(),s=ctx.member.securityStamp,key=crypto.randomUUID(),intent={commandId:key,idempotencyKey:key,action:'M01.'+payload.operation,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch};
 return ()=>executeM01(ctx,intent);
}
test('P3-ORIGIN-OBS07: required text rejects empty, whitespace and blank defaults in each declared entry template before any write',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());
 const snapshot=()=>Object.fromEntries(['r1_m01_entities','r1_m01_versions','r1_identity_keys','r1_commands','r1_outbox','r1_recovery_changes','hris_audit_events','hris_memberships'].map(table=>[table,f.sqlite.prepare('SELECT count(*) n FROM '+table).get().n]));
 for(const entryType of ['employee_create','prehire','onboard']){
  const template=await f.send({operation:'template',orgId:'A',kind:'custom',entryType,fields:[{code:'email',type:'text',required:true,default:'  ',uniqueKey:false,readActions:['read'],writeActions:['update']}]});
  const payload={operation:'person',code:'blank-'+entryType,name:'隔离必填验证',orgId:'A',templateId:template.result.ids[0],entryType,fields:{}};
  for(const fields of [{},{email:null},{email:''},{email:' \t\n '}]){
   const before=snapshot();await assert.rejects(f.send({...payload,fields}),/必填/);assert.deepEqual(snapshot(),before);
  }
  const valid={...payload,fields:{email:'isolated@example.invalid'}},invoke=await retainedOriginCommand(valid),saved=await invoke(),after=snapshot();
  assert.equal((await invoke()).replayed,true);assert.deepEqual(snapshot(),after);assert.equal((await m01Entity(f.db,f.tenant,saved.result.ids[0])).payload.fields.email,'isolated@example.invalid');
 }
});
test('P3-ORIGIN-OBS07: required subset blank update rolls back, optional blank and numeric zero remain valid, unauthorized writes remain denied',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());
 f.sqlite.prepare("UPDATE r1_permission_grants SET fields='[\"record\",\"name\",\"skill\",\"score\"]' WHERE member_id='owner' AND object_type='M01'").run();
 const field=(code,type,required)=>({code,type,required,default:null,uniqueKey:false,readActions:['read'],writeActions:['update'],...(type==='number'?{unit:'points',precision:0}:{})});
 const template=await f.send({operation:'template',orgId:'A',kind:'skill',entryType:'subset',fields:[field('skill','text',true),field('name','text',false),field('score','number',true)]});
 const payload={operation:'subsetImport',personId:'person',orgId:'A',templateId:template.result.ids[0],templateVersion:1,batchId:'isolated-required-subset',rowNo:1,attemptVersion:1,mode:'create',recordId:null,fields:{skill:' 合成技能 ',name:' ',score:0}},saved=await f.send(payload),recordId=saved.result.ids[0];
 assert.deepEqual((await m01Entity(f.db,f.tenant,recordId)).payload.fields,{skill:'合成技能',name:'',score:0});
 const old=f.sqlite.prepare('SELECT payload FROM r1_m01_versions WHERE entity_id=?').get(recordId).payload,revision=(await m01Entity(f.db,f.tenant,recordId)).revision;
 const update={...payload,rowNo:2,mode:'update',recordId,fields:{skill:' \t '}};
 await assert.rejects(f.send(update),/必填/);assert.equal((await m01Entity(f.db,f.tenant,recordId)).revision,revision);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_import_receipts WHERE batch_id=? AND row_no=2').get(payload.batchId).n,0);
 const fixed={...update,fields:{skill:'合成新技能'}},invoke=await retainedOriginCommand(fixed);await invoke();assert.equal((await invoke()).replayed,true);assert.equal(f.sqlite.prepare('SELECT payload FROM r1_m01_versions WHERE entity_id=? AND version=1').get(recordId).payload,old);
 f.sqlite.prepare("UPDATE r1_permission_grants SET fields='[\"record\"]' WHERE member_id='owner' AND object_type='M01' AND action='subsetImport'").run();
 await assert.rejects(f.send({...fixed,rowNo:3}),e=>e.status===403);
});
test('P3-M01-10: exit fence rejects later approvals and queues all 101 cleanup items',async()=>{
 const f=await fixture();f.seed('employment','employment','A','person',{startOn:past},'active');f.seed('exit','exit_request','A','person',{lastWorkingOn:'2026-01-01',reviewerId:'reviewer'},'approved');
 for(let i=0;i<101;i++)f.seed('work-'+i,'assignment_request','A','person',{reviewerId:'reviewer',createdBy:'owner'},'pending');
 await f.send({operation:'exitExecute',id:'exit'});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_exit_cleanup').get().n,101);
 act('reviewer');await assert.rejects(f.send({operation:'assignmentApprove',id:'work-1'}),/退出/);f.sqlite.close();
});
test('P3-M01-12: protected waiting dependency blocks disable without exposing identity',async()=>{
 const f=await fixture();f.seed('waiting','assignment_request','A','person',{positionId:'position-a'},'approved');
 // Non-overlapping next version exercises dependency rather than an interval conflict.
 
 await assert.rejects(f.send({operation:'catalog',id:'position-a',closePreviousVersion:1,kind:'position',code:'PA',name:'岗位',orgId:'A',parentId:'',status:'inactive',validFrom:today,validTo:null,attributes:{}}),e=>e.message==='存在受保护的未完成依赖，请联系负责人');f.sqlite.close();
});
test('P3-M01-11: explicit strong budget policy blocks effect; absent provider never reports budget passed',async()=>{
 const f=await fixture();f.seed('employment','employment','A','person',{startOn:past},'active');
 f.seed('request','assignment_request','A','person',{personId:'person',employmentId:'employment',orgId:'A',positionId:'position-a',type:'primary',validFrom:today,validTo:null,attempts:0},'approved');
 f.seed('budget','budget_policy','A',null,{strongBlocking:true});
 const r=await f.send({operation:'assignmentExecute',id:'request'});assert.equal(r.result.effectStatus,'failed');assert.match((await m01Entity(f.db,f.tenant,'request')).payload.failure,/金额预算/);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_m01_entities WHERE kind='assignment'").get().n,0);f.sqlite.close();
});
test('temporal versions: future publication preserves today and old bytes, all interval cuts reject historical hidden cycles',async()=>{
 const f=await fixture();const {catalogTimeline,temporalCatalogCheck}=await import('../lib/hris/r1-temporal.ts');
 const before=f.sqlite.prepare("SELECT payload FROM r1_m01_versions WHERE entity_id='position-a'").get().payload;
 await f.send({operation:'catalog',id:'position-a',closePreviousVersion:1,kind:'position',code:'PA',name:'岗位未来名',orgId:'A',parentId:'',status:'active',validFrom:'2027-01-01',validTo:null,attributes:{}});
 const timeline=await catalogTimeline(f.db,f.tenant,'position');assert.equal(timeline.find(v=>v.id==='position-a'&&v.payload.validFrom<=today).payload.name,'岗位');
 assert.equal(f.sqlite.prepare("SELECT payload FROM r1_m01_versions WHERE entity_id='position-a' AND version=1").get().payload,before);
 const node=(id,parent,from,to)=>({id,kind:'org',personId:null,orgId:'A',code:id,revision:1,status:'active',payload:{name:id,parentId:parent,validFrom:from,validTo:to}});
 assert.throws(()=>temporalCatalogCheck([node('x','y','2027-01-01','2027-03-31'),node('x','','2027-04-01',null),node('y','x','2027-01-01','2027-02-01'),node('y','','2027-02-02',null)],'org'),/时态环/);f.sqlite.close();
});
test('exit generation: rehire enables only new segment; cleanup resumes and unsupported domains retain blocked receipts',async()=>{
 const f=await fixture();f.seed('old-employment','employment','A','person',{startOn:past},'active');f.seed('exit','exit_request','A','person',{lastWorkingOn:'2026-01-01'},'approved');
 for(let i=0;i<101;i++)f.seed('todo-'+String(i).padStart(3,'0'),i===100?'unsupported':'assignment_request','A','person',{employmentId:'old-employment',reviewerId:'reviewer',createdBy:'owner'},'pending');
 await f.send({operation:'exitExecute',id:'exit'});
 const e=await f.send({operation:'employment',personId:'person',orgId:'A',identityReviewId:'review',predecessorId:'old-employment',startOn:today,employmentType:'employee'});
 const payload={operation:'assignmentRequest',personId:'person',employmentId:e.result.ids[0],orgId:'A',positionId:'position-a',type:'primary',homePrimaryId:null,validFrom:today,validTo:null,reviewerId:'reviewer',reason:'已复核重聘'};
 await assert.rejects(f.send({...payload,employmentId:'old-employment'}),/代次/);
 const r=await f.send(payload);act('reviewer');await f.send({operation:'assignmentApprove',id:r.result.ids[0]});await assert.rejects(f.send({operation:'assignmentApprove',id:'todo-001'}),/代次/);act('owner');await f.send({operation:'assignmentExecute',id:r.result.ids[0]});
 for(let i=0;i<6;i++)await f.send({operation:'exitCleanup',personId:'person',orgId:'A',limit:20});
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_exit_cleanup WHERE status='cancelled'").get().n,100);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_exit_cleanup WHERE status='blocked_by_exit'").get().n,1);
 assert.equal((await m01Entity(f.db,f.tenant,r.result.ids[0])).status,'applied');
 assert.equal((await f.send({operation:'exitCleanup',personId:'person',orgId:'A',limit:20})).result.processed,0);f.sqlite.close();
});
test('command replay runs before stale business-state validation and does not create a second employment',async()=>{
 const f=await fixture(),c=await memberContext(),s=c.member.securityStamp,key=crypto.randomUUID(),payload={operation:'employment',personId:'person',orgId:'A',identityReviewId:'review',predecessorId:null,startOn:today,employmentType:'employee'};
 const intent={commandId:key,idempotencyKey:key,action:'M01.employment',payload,expectedWorkspaceRevision:c.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch};
 const a=await executeM01(c,intent),b=await executeM01(await memberContext(),intent);assert.equal(b.replayed,true);assert.deepEqual(a.result.ids,b.result.ids);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_m01_entities WHERE kind='employment'").get().n,1);f.sqlite.close();
});
test('server identity candidates: forged candidate list cannot hide a second identifier match; protected keys contain no raw values',async()=>{
 const f=await fixture();f.seed('other-person','person','B',null,{name:'另一合成人员'},'ended','E2');
 await f.send({operation:'identityBind',personId:'person',orgId:'A',identifiers:[{type:'document',value:'SYNTHETIC-DOC-A'},{type:'email',value:'shared@example.invalid'}],evidenceRef:'fixture-review-A'});
 await f.send({operation:'identityBind',personId:'other-person',orgId:'B',identifiers:[{type:'document',value:'SYNTHETIC-DOC-B'},{type:'email',value:'shared@example.invalid'}],evidenceRef:'fixture-review-B'});
 await assert.rejects(f.send({operation:'identityReview',personId:'person',candidateIds:['person'],identifiers:[{type:'document',value:'SYNTHETIC-DOC-A'},{type:'document',value:'SYNTHETIC-DOC-B'}],reason:'隔离冲突核验',evidenceRef:'fixture-conflict'}),/身份复核/);
 await assert.rejects(f.send({operation:'identityReview',personId:'person',candidateIds:['person'],identifiers:[{type:'email',value:'shared@example.invalid'}],reason:'邮件只是线索',evidenceRef:'fixture-shared'}),/身份复核/);
 const r=await f.send({operation:'identityReview',personId:'person',candidateIds:['person'],identifiers:[{type:'document',value:'SYNTHETIC-DOC-A'}],reason:'独立核验证件',evidenceRef:'fixture-confirm'});assert.equal((await m01Entity(f.db,f.tenant,r.result.ids[0])).status,'confirmed');
 assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM r1_identity_keys').all()).includes('SYNTHETIC-DOC'));assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_m01_entities WHERE kind='person'").get().n,2);f.sqlite.close();
});
test('contract field roots survive revisions and inheritance; explicit null clears; stable contract counts exclude unknown and cancelled',async()=>{
 const f=await fixture(),{contractCounts}=await import('../lib/hris/r1-personnel-data.ts');f.seed('legal','legal_entity','A',null,{name:'合成法人',validFrom:past,validTo:null,attributes:{orgIds:['A']}},'active','LE');
 const definition=await f.send({operation:'contractField',orgId:'A',code:'note',name:'合同说明',inheritPrevious:true,status:'active'}),field=definition.result.ids[0];
 for(const who of ['owner','reviewer'])f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,who+'contract-fields',who,'M01','contract','scope','["A"]',JSON.stringify([field]),'current',past,null);
 const base={operation:'contract',personId:'person',orgId:'A',legalEntityId:'legal',number:'C-01',agreementCategory:'labor',contractType:'fixed',start:'2026-01-01',end:'2026-12-31',renewalOf:null,fields:{[field]:'历史原值'}};
 const first=(await f.send(base)).result.ids[0];await f.send({operation:'contractSign',id:first,signedOn:today,evidence:'隔离人工登记'});
 const hash=f.sqlite.prepare('SELECT payload FROM r1_m01_versions WHERE entity_id=? ORDER BY version').all(first);
 await f.send({operation:'contractField',id:field,orgId:'A',code:'note',name:'合同说明新版',inheritPrevious:true,status:'active'});
 const second=(await f.send({...base,number:'C-02',start:'2027-01-01',end:'2027-12-31',renewalOf:first,fields:{}})).result.ids[0];let c=await m01Entity(f.db,f.tenant,second);assert.equal(c.payload.fieldSnapshots[0].value,'历史原值');assert.equal(c.payload.fieldSnapshots[0].sourceContractId,first);assert.equal(c.payload.fieldSnapshots[0].sourceFieldVersion,1);assert.equal(c.payload.fieldSnapshots[0].version,2);
 await f.send({...base,id:second,number:'C-02',start:'2027-01-01',end:'2027-12-31',renewalOf:first,fields:{[field]:null}});c=await m01Entity(f.db,f.tenant,second);assert.equal(c.payload.fieldSnapshots[0].value,null);await f.send({operation:'contractSign',id:second,signedOn:today,evidence:'隔离登记第二份'});
 assert.deepEqual(f.sqlite.prepare('SELECT payload FROM r1_m01_versions WHERE entity_id=? ORDER BY version').all(first),hash);
 const a=await m01Entity(f.db,f.tenant,first),b=await m01Entity(f.db,f.tenant,second),count=contractCounts([a,b,{...b,revision:1},{...a,id:'cancelled',status:'cancelled'},{...a,id:'unknown',payload:{legalEntityId:'legal'}}]);assert.equal(count.groups[0].count,2);assert.deepEqual(count.unknownIds,['unknown']);assert.equal(count.automaticOpenEnded,false);assert.equal(count.automaticTermination,false);f.sqlite.close();
});
test('ten subset types plus custom preserve field versions, reject missing field permission and enforce exact decimal precision',async()=>{
 const f=await fixture();for(const kind of ['education','employment','family','appraisal','training','reward','certificate','project','skill','language','custom']){
  const t=(await f.send({operation:'template',orgId:'A',kind,entryType:'subset',fields:[{code:'skill',type:'number',unit:'小时',precision:2,required:false,default:null,uniqueKey:true,readActions:['read'],writeActions:['update']}]})).result.ids[0];
  const row={operation:'subsetImport',personId:'person',orgId:'A',templateId:t,templateVersion:1,batchId:'types-'+kind,rowNo:1,attemptVersion:1,mode:'create',recordId:null,fields:{skill:'1.25'}};
  const r=await f.send(row);await assert.rejects(f.send({...row,rowNo:2,fields:{skill:'1.256'}}),/精度/);await assert.rejects(f.send({...row,rowNo:3}),/唯一键/);
  await f.send({...row,rowNo:4,mode:'update',recordId:r.result.ids[0],fields:{skill:null}});assert.equal((await m01Entity(f.db,f.tenant,r.result.ids[0])).revision,2);
 }
 const t=(await f.send({operation:'template',orgId:'A',kind:'custom',entryType:'subset',fields:[{code:'protected',type:'text',required:false,default:null,uniqueKey:false,readActions:['read'],writeActions:['update']}]})).result.ids[0];
 await assert.rejects(f.send({operation:'subsetImport',personId:'person',orgId:'A',templateId:t,templateVersion:1,batchId:'denied',rowNo:1,attemptVersion:1,mode:'create',recordId:null,fields:{protected:'不得落库'}}),/字段权限/);f.sqlite.close();
});
test('M01 paged reads enforce field tuples and reject a cursor after permission revision changes',async()=>{
 const f=await fixture(),{readM01}=await import('../lib/hris/r1-m01-read.ts');
 f.seed('person-2','person','A',null,{name:'另一个合成人员',email:'hidden@example.invalid',fields:{email:'hidden@example.invalid',skill:'可见字段'}},'active','E2');
 f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,'read-only','owner','M01','read','scope','["A"]','["record","skill"]','current',past,null);
 const first=await readM01(await memberContext(),new URLSearchParams('kind=person&limit=1'));assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=await readM01(await memberContext(),new URLSearchParams({kind:'person',limit:'1',cursor:first.nextCursor}));assert.equal(second.items[0].payload.email,undefined);assert.equal(second.items[0].payload.fields.email,undefined);assert.equal(second.items[0].payload.fields.skill,'可见字段');
 f.sqlite.prepare("UPDATE r1_permission_grants SET fields='[]' WHERE id='read-only'").run();await assert.rejects(readM01(await memberContext(),new URLSearchParams({kind:'person',limit:'1',cursor:first.nextCursor})),/重新读取/);f.sqlite.close();
});
test('client unknown result retains exact command identity and resolves through the receipt without a second send',async()=>{
 const {clientIntent,sendClientCommand,queryClientCommand}=await import('../lib/hris/r1-client-command.ts');
 const intent=clientIntent({revision:7,securityStamp:{authorizationRevision:3,writerEpoch:1,recoveryEpoch:2,openGate:1,phase:'features_enabled',featuresEnabled:1}},'person',{operation:'person',code:'fixture'});let sends=0;
 const lost=await sendClientCommand(intent,async()=>{sends++;throw Error('synthetic lost response');});assert.equal(lost.state,'unknown');assert.equal(lost.commandId,intent.commandId);
 const found=await queryClientCommand(intent.commandId,async url=>{assert.ok(url.endsWith(intent.commandId));return Response.json({status:'committed',commandId:intent.commandId,result:'{}'});});assert.equal(found.state,'committed');assert.equal(sends,1);
});
test('catalog acceptance: sibling names, cross-parent reuse, same grade names with distinct codes, and concurrent protected references',async()=>{
 const f=await fixture();const org={operation:'catalog',kind:'org',code:'CHILD-1',name:'同名部门',orgId:'A',parentId:'A',status:'active',validFrom:today,validTo:null,attributes:{}};
 await f.send(org);await assert.rejects(f.send({...org,code:'CHILD-2'}),/名称冲突/);await f.send({...org,code:'CHILD-2',orgId:'B',parentId:'B'});
 const grade={operation:'catalog',kind:'grade',code:'G1',name:'专家',orgId:'A',parentId:'',status:'active',validFrom:today,validTo:null,attributes:{sequence:1,familyId:'family'}};
 await f.send(grade);await f.send({...grade,code:'G2',attributes:{sequence:2,familyId:'family'}});await assert.rejects(f.send({...grade,orgId:'B'}),/编码已存在/);
 f.seed('employment','employment','A','person',{startOn:past},'active');
 const ctx=await memberContext(),stamp=ctx.member.securityStamp;function intent(payload){const key=crypto.randomUUID();return {commandId:key,idempotencyKey:key,action:'M01.'+payload.operation,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:stamp.authorizationRevision,expectedWriterEpoch:stamp.writerEpoch,expectedRecoveryEpoch:stamp.recoveryEpoch};}
 const disable={operation:'catalog',id:'position-a',closePreviousVersion:1,kind:'position',code:'PA',name:'岗位',orgId:'A',parentId:'',status:'inactive',validFrom:today,validTo:null,attributes:{}};
 const request={operation:'assignmentRequest',personId:'person',employmentId:'employment',orgId:'A',positionId:'position-a',type:'primary',homePrimaryId:null,validFrom:today,validTo:null,reviewerId:'reviewer',reason:'并发依赖合成'};
 const result=await Promise.allSettled([executeM01(ctx,intent(disable)),executeM01(ctx,intent(request))]);assert.ok(result.filter(r=>r.status==='fulfilled').length<=1);f.sqlite.close();
});
test('all additional assignments occupy zero; duplicate overlap fails, cancellation preserves the case, ending releases no extra headcount',async()=>{
 const f=await fixture();f.seed('employment','employment','A','person',{startOn:past},'active');f.seed('primary','assignment','A','person',{type:'primary',employmentId:'employment',positionId:'position-a',validFrom:past,validTo:null,occupancy:1});
 for(const type of ['part_time','secondment','expatriate']){
  const request={operation:'assignmentRequest',personId:'person',employmentId:'employment',orgId:'B',positionId:'position-b',type,homePrimaryId:'primary',validFrom:today,validTo:null,reviewerId:'reviewer',reason:'合成'+type};
  let id=(await f.send(request)).result.ids[0];act('reviewer');await f.send({operation:'assignmentApprove',id});act('owner');const assignment=(await f.send({operation:'assignmentExecute',id})).result.assignmentId;
  id=(await f.send(request)).result.ids[0];act('reviewer');await f.send({operation:'assignmentApprove',id});act('owner');assert.equal((await f.send({operation:'assignmentExecute',id})).result.effectStatus,'failed');await f.send({operation:'assignmentCancel',id,reason:'保留重复申请失败后取消记录'});
  id=(await f.send({...request,endAssignmentId:assignment})).result.ids[0];act('reviewer');await f.send({operation:'assignmentApprove',id});act('owner');await f.send({operation:'assignmentExecute',id});assert.equal((await m01Entity(f.db,f.tenant,assignment)).status,'ended');
 }
 assert.equal(f.sqlite.prepare('SELECT sum(delta) n FROM r1_occupancy_events').get().n,0);assert.equal((await m01Entity(f.db,f.tenant,'primary')).payload.occupancy,1);f.sqlite.close();
});
test('history read needs separate history authorization; present record access never reveals past fields',async()=>{
 const f=await fixture(),route=await import('../app/api/r1/m01/[id]/history/route.ts');
 const t=(await f.send({operation:'template',orgId:'A',kind:'skill',entryType:'subset',fields:[{code:'skill',type:'text',required:false,default:null,uniqueKey:false,readActions:['read'],writeActions:['update']}]})).result.ids[0];
 const id=(await f.send({operation:'subsetImport',personId:'person',orgId:'A',templateId:t,templateVersion:1,batchId:'history',rowNo:1,attemptVersion:1,mode:'create',recordId:null,fields:{skill:'受保护历史'}})).result.ids[0];
 const call=()=>route.GET(request('/api/r1/m01/'+id+'/history'),{params:Promise.resolve({id})});assert.equal((await call()).status,403);
 f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,'history-read','owner','M01','read','scope','["A"]','["record"]','history',past,null);
 const response=await call();assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.items[0].payload.payload.fields,{});f.sqlite.close();
});
test('UI form payloads keep explicit null, stable IDs, two D7 reviewers and server validation contracts',async()=>{
 const {personnelPayload}=await import('../lib/hris/r1-form-model.ts'),{m01Input}=await import('../lib/hris/r1-m01.ts');
 const lists={person:[{id:'p',orgId:'A'}],template:[{id:'t',revision:3}]};
 const row=personnelPayload('subsetImport',{personId:'p',templateId:'t',batchId:'b',rowNo:'2',attemptVersion:'1',mode:'update',recordId:'r'},lists,{skill:null},[]);assert.equal(m01Input.parse(row).fields.skill,null);assert.equal(row.templateVersion,3);
 const workflow=personnelPayload('transferWorkflow',{reviewerOutId:'a',reviewerInId:'b'},lists,{},[]);assert.deepEqual(workflow.command.steps.map(x=>x.userId),['a','b']);
 const sign=personnelPayload('contractSign',{id:'c',signedOn:today,evidence:'明确为人工登记'},lists,{},[]);assert.equal(m01Input.parse(sign).operation,'contractSign');
});
test('three entry templates stay independent and saving never invites or creates membership',async()=>{
 const f=await fixture(),before=f.sqlite.prepare('SELECT * FROM hris_memberships ORDER BY user_id').all();
 for(const entryType of ['employee_create','prehire','onboard']){
  const t=(await f.send({operation:'template',orgId:'A',kind:'custom',entryType,fields:[{code:'name',type:'text',required:true,default:null,uniqueKey:false,readActions:['read'],writeActions:['update']}]})).result.ids[0];
  const person={operation:'person',orgId:'A',code:'NEW-'+entryType,name:'入口合成人员',entryType,templateId:t,fields:{name:'真实填写的合成值'}};
  await assert.rejects(f.send({...person,entryType:entryType==='prehire'?'onboard':'prehire'}),/入口模板/);const id=(await f.send(person)).result.ids[0];assert.equal((await m01Entity(f.db,f.tenant,id)).payload.invite,false);
 }
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM hris_memberships ORDER BY user_id').all(),before);f.sqlite.close();
});
test('exit and approval racing share the tenant CAS; final exit blocks every later completion',async()=>{
 const f=await fixture();f.seed('employment','employment','A','person',{startOn:past},'active');f.seed('exit-race','exit_request','A','person',{lastWorkingOn:'2026-01-01'},'approved');f.seed('approval-race','assignment_request','A','person',{reviewerId:'reviewer',createdBy:'owner',employmentId:'employment'},'pending');
 act('owner');const owner=await memberContext();act('reviewer');const reviewer=await memberContext();
 const intent=(ctx,payload)=>{const id=crypto.randomUUID(),s=ctx.member.securityStamp;return {commandId:id,idempotencyKey:id,action:'M01.'+payload.operation,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch};};
 const exit={operation:'exitExecute',id:'exit-race'},approve={operation:'assignmentApprove',id:'approval-race'},out=await Promise.allSettled([executeM01(owner,intent(owner,exit)),executeM01(reviewer,intent(reviewer,approve))]);assert.equal(out.filter(r=>r.status==='fulfilled').length,1);
 act('owner');if(!f.sqlite.prepare('SELECT 1 FROM r1_exit_fences').get())await f.send(exit);act('reviewer');await assert.rejects(f.send(approve),/退出/);f.sqlite.close();
});
test('P3-LINK-M48-approval + P3-M19-01/04 + P3-M48-05: real R1 portal and regularize adapter updates stable person and normalized employee atomically',async()=>{
 const {executeWorkflow}=await import('../lib/hris/r1-workflow.ts');const f=await fixture();f.seed('employment','employment','A','person',{startOn:past,exitFenceObserved:null},'active');
 f.sqlite.exec('DROP TRIGGER r1_guard_hris_employees_insert');f.sqlite.prepare("INSERT INTO hris_employees(tenant_id,id,code,name,org_id,job,level,joined,status,email) VALUES (?,'person','E1','合成转正人员','A','','','2020-01-01','试用','')").run(f.tenant);
 f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,'regularizeRequest','owner','M01','regularizeRequest','scope','["A"]','["record"]','current',past,null);
 for(const who of ['owner','reviewer'])for(const action of ['configure','start','decide'])f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,who+'wf'+action,who,'M19',action,'scope','["A"]','["record"]','current',past,null);
 const request=await f.send({operation:'regularizeRequest',personId:'person',orgId:'A',reason:'合成转正核验'}),sourceId=request.result.ids[0];const send=async(payload)=>{const ctx=await memberContext(),s=ctx.member.securityStamp,id=crypto.randomUUID();return executeWorkflow(ctx,{commandId:id,idempotencyKey:id,action:'M19.'+payload.operation,payload,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch});};
 await send({operation:'publish',id:'reg',orgId:'A',definition:{businessType:'personnel.regularize',adapterVersion:'r1-regularize-v1',entry:'review',fields:{},nodes:[{id:'review',type:'review',assignees:['reviewer'],passPolicy:'all',rejectPolicy:'any_reject',next:'end'},{id:'end',type:'end'}],interventionTargets:['review'],notificationTemplateVersion:null}});
 const r=await send({operation:'start',templateId:'reg',businessType:'personnel.regularize',businessId:sourceId,applicationVersion:1});act('reviewer');
 f.sqlite.exec("CREATE TRIGGER regularize_fault BEFORE UPDATE ON hris_employees BEGIN SELECT RAISE(ABORT,'synthetic_compatibility_failure'); END");const decide={operation:'decide',id:r.result.instanceId,expectedRevision:1,generation:1,nodeRevision:1,decision:'approved',reason:'合成独立核验'};await assert.rejects(send(decide),/synthetic_compatibility_failure/);assert.equal((await m01Entity(f.db,f.tenant,sourceId)).status,'pending');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_workflow_decisions').get().n,0);
 f.sqlite.exec('DROP TRIGGER regularize_fault; DROP TRIGGER r1_guard_hris_memberships_update');
 f.sqlite.prepare("UPDATE hris_memberships SET employee_id='review-person' WHERE user_id='reviewer'").run();f.seed('review-person','person','A',null,{name:'合成独立审核人员'});
 for(const action of ['read','decide'])f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,'portal-'+action,'reviewer','M48','approvals.'+action,'scope','["A"]','["record","title","approvalStatus","effectStatus","nodeRevision","generation"]','current',past,null);
 f.sqlite.prepare('INSERT INTO r1_permission_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(f.tenant,'portal-source-read','reviewer','M19','read','scope','["A"]','["record"]','current',past,null);
 const {readPortal,portalAction}=await import('../lib/hris/r1-portal.ts'),ctx=await memberContext(),portal=await readPortal(ctx,new URLSearchParams({entry:'approvals'})),item=portal.items[0];assert.equal(item.businessId,r.result.instanceId);assert.deepEqual(item.sourceIdentity,{businessId:sourceId,instanceId:r.result.instanceId,personId:'person'});assert.equal(portal.contractVersion,'r1-m19-portal-v1');assert.equal(item.partition,'authorized_others');assert.deepEqual(item.allowedActions,['decide']);const stamp=ctx.member.securityStamp,commandId=crypto.randomUUID();const before=f.db.batch;f.db.batch=async statements=>{const result=await before(statements);if(statements.some(s=>s.sql.includes('UPDATE r1_workflow_instances')))throw Error('synthetic_producer_reply_lost_after_commit');return result;};await assert.rejects(portalAction(ctx,{entry:'approvals',businessId:item.businessId,sourceVersion:item.sourceVersion,sourceRevision:item.sourceRevision,action:'decide',intent:{commandId,idempotencyKey:commandId,expectedWorkspaceRevision:ctx.row.revision,expectedAuthorizationRevision:stamp.authorizationRevision,expectedWriterEpoch:stamp.writerEpoch,expectedRecoveryEpoch:stamp.recoveryEpoch,payload:{decision:'approved',reason:'合成门户原单办理',nodeRevision:item.fields.nodeRevision,generation:item.fields.generation}}}),/synthetic_producer_reply_lost_after_commit/);f.db.batch=before;const {commandReceipt}=await import('../lib/hris/r1-command.ts'),receipt=await commandReceipt(f.db,(await memberContext()).member,commandId);assert.equal(receipt.status,'committed');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_workflow_decisions WHERE node_id IN (SELECT id FROM r1_workflow_nodes WHERE instance_id=?)').get(r.result.instanceId).n,1);
assert.equal((await m01Entity(f.db,f.tenant,'person')).payload.probationStatus,'formal');assert.equal((await m01Entity(f.db,f.tenant,sourceId)).status,'applied');assert.equal(f.sqlite.prepare("SELECT status FROM hris_employees WHERE id='person'").get().status,'正式');f.sqlite.close();
});
