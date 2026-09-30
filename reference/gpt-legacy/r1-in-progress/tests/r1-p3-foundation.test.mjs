import {database,act,request} from './support/runtime.mjs';
import {readdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {memberContext,readConsistent}=await import('../lib/hris/context.ts');
const {commitCommand,commandReceipt,securityStamp}=await import('../lib/hris/r1-command.ts');
const {tupleAllowed}=await import('../lib/hris/r1-authorization.ts');
const access=await import('../app/api/access/route.ts');
const members=await import('../app/api/members/route.ts');
const hris=await import('../app/api/hris/route.ts');
const {migrateWorkspace}=await import('../lib/hris/repository.ts');
async function fresh(){
 const x=database();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())x.sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
 globalThis.p2env.DB=x.db;act('owner');assert.equal((await access.POST(request('/api/access',{action:'setup',name:'R1合成隔离企业'}))).status,200);
 return {...x,ctx:await memberContext()};
}
function intent(c,id){const s=c.member.securityStamp;return {commandId:id,idempotencyKey:id,action:'test.rename',payload:{name:'合成目录'},expectedWorkspaceRevision:c.row.revision,expectedAuthorizationRevision:s.authorizationRevision,expectedWriterEpoch:s.writerEpoch,expectedRecoveryEpoch:s.recoveryEpoch};}
function plan(c){return token=>[c.db.prepare("INSERT INTO hris_orgs(tenant_id,id,name,parent_id,city,leader,status) SELECT owner,'org-a','合成目录',NULL,'上海','','启用' FROM hris_workspaces WHERE owner=? AND last_mutation=?").bind(c.member.tenantId,token)];}
const count=(s,t)=>s.prepare('SELECT count(*) n FROM '+t).get().n;
test('P3-ARC-01 / BASE-01-AC01: inactive, isolation and stale same-role authority reject',async()=>{
 const {ctx:c,sqlite,db}=await fresh();
 const before=count(sqlite,'hris_audit_events');
 sqlite.prepare('UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=?').run(c.member.tenantId);
 await assert.rejects(commitCommand(db,c.member,c.member.securityStamp,intent(c,'stale'),plan(c)),/授权水位/);
 assert.equal(count(sqlite,'hris_orgs'),0);assert.equal(count(sqlite,'r1_commands'),0);assert.equal(count(sqlite,'r1_outbox'),0);assert.equal(count(sqlite,'hris_audit_events'),before);
 sqlite.prepare('UPDATE r1_schema_state SET open_gate=0').run();await assert.rejects(memberContext(),/隔离/);await assert.rejects(commandReceipt(db,c.member,'stale'),/隔离/);
 sqlite.prepare('UPDATE r1_schema_state SET open_gate=1').run();
 // Direct old writers, including membership activation, cannot bypass the SQL barrier.
 assert.throws(()=>sqlite.exec("UPDATE hris_memberships SET active=0"),/WRITER_NOT_FENCED/);
 const current=await memberContext();
 await commitCommand(db,current.member,current.member.securityStamp,intent(current,'deactivate'),token=>[db.prepare('UPDATE hris_memberships SET active=0 WHERE user_id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind('owner',c.member.tenantId,token)]);
 await assert.rejects(memberContext(),/有效/);sqlite.close();
});
test('P3-ARC-01 / BASE-02-AC02: supplementary reads reject epoch or scope changes',async()=>{
 const {ctx:c,sqlite,db}=await fresh();
 sqlite.exec('UPDATE r1_schema_state SET writer_epoch=writer_epoch+1');
 await assert.rejects(readConsistent(c,[db.prepare('SELECT 1')]),/水位/);
 await assert.rejects(commitCommand(db,c.member,c.member.securityStamp,intent(c,'old-epoch'),plan(c)),/水位/);
 assert.throws(()=>sqlite.exec("UPDATE hris_workspaces SET revision=revision+1,last_mutation='old-worker'"),/WRITER_NOT_FENCED/);
 await assert.rejects(migrateWorkspace(db,c.member,{data:'{}',revision:0,storageVersion:0}),/旧迁移入口/);sqlite.close();
});
test('P3-ARC-01: grant tuples do not cross product roles, fields, history, relations or actions',()=>{
 const m={userId:'m',tenantId:'t',employeeId:'manager',role:'admin',active:1};
 const g=(scope,fields,relationType='direct')=>({objectType:'person',action:'read',relationType,scope,fields,historyMode:'current',validFrom:'2026-01-01',validTo:null});
 const grants=[g(['A'],['name','level']),g(['B'],['name'],'dotted')],relations=[{subjectPersonId:'a',relationType:'direct',validFrom:'2026-01-01',validTo:null},{subjectPersonId:'b',relationType:'dotted',validFrom:'2026-01-01',validTo:null}];
 const q={objectType:'person',action:'read',orgId:'A',personId:'a',field:'level',historyMode:'current'};
 assert.equal(tupleAllowed(m,grants,relations,q),true);
 for(const patch of [{orgId:'B',personId:'b'},{action:'export'},{historyMode:'history'},{field:'salary'},{denied:true},{personId:'unrelated'}])assert.equal(tupleAllowed(m,grants,relations,{...q,...patch}),false);
});
test('P3-ARC-02: audit failure rolls back facts, journal, receipt and outbox; next command succeeds once',async()=>{
 const {ctx:c,sqlite,db}=await fresh();
 const before={audit:count(sqlite,'hris_audit_events'),journal:count(sqlite,'r1_recovery_changes')};
 sqlite.exec("CREATE TRIGGER inject_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure');END");
 await assert.rejects(commitCommand(db,c.member,c.member.securityStamp,intent(c,'failure'),plan(c)),/synthetic audit/);
 assert.equal(count(sqlite,'hris_orgs'),0);assert.equal(count(sqlite,'r1_commands'),0);assert.equal(count(sqlite,'r1_outbox'),0);assert.equal(count(sqlite,'hris_audit_events'),before.audit);assert.equal(count(sqlite,'r1_recovery_changes'),before.journal);
 sqlite.exec('DROP TRIGGER inject_audit');
 const result=await commitCommand(db,c.member,c.member.securityStamp,intent(c,'success'),plan(c));assert.equal(result.status,'committed');
 const replay=await commitCommand(db,c.member,c.member.securityStamp,intent(c,'success'),plan(c));assert.equal(replay.replayed,true);
 assert.equal(count(sqlite,'hris_orgs'),1);assert.equal(count(sqlite,'r1_outbox'),1);
 const journal=sqlite.prepare("SELECT after_image FROM r1_recovery_changes WHERE table_name='hris_orgs'").get();assert.equal(JSON.parse(journal.after_image).name,'合成目录');
 assert.equal((await commandReceipt(db,c.member,'success')).status,'committed');
 await assert.rejects(commitCommand(db,c.member,c.member.securityStamp,{...intent(c,'success'),payload:{name:'other'}},plan(c)),/冲突/);
 assert.equal(await commandReceipt(db,{...c.member,userId:'outsider'},'success'),null);sqlite.close();
});
test('P3-ARC-02: concurrent commands and lost response produce at most one business effect',async()=>{
 const {ctx:c,sqlite,db}=await fresh(),i=intent(c,'race');
 const results=await Promise.allSettled([commitCommand(db,c.member,c.member.securityStamp,i,plan(c)),commitCommand(db,c.member,c.member.securityStamp,i,plan(c))]);
 assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(count(sqlite,'hris_orgs'),1);assert.equal(count(sqlite,'r1_commands'),1);assert.equal(count(sqlite,'r1_outbox'),1);
 assert.equal((await commandReceipt(db,c.member,'race')).status,'committed');assert.equal(await commandReceipt(db,c.member,'absent'),null);sqlite.close();
});
test('P3-ARC-01: legacy HR and membership routes use the bridge; activation cannot bypass isolation',async()=>{
 const {sqlite}=await fresh();let c=await memberContext();
 let r=await hris.POST(request('/api/hris',{revision:c.row.revision,command:{action:'org',name:'合成组织',parentId:'',city:'上海',leader:'',status:'启用'}}));assert.equal(r.status,200,await r.text());
 c=await memberContext();r=await members.POST(request('/api/members',{revision:c.row.revision,email:'fixture@example.com',name:'合成角色',role:'hr',employeeId:null,active:true,orgScope:[JSON.parse(c.row.data).orgs[0].id],viewEmail:false,viewLevel:false}));assert.equal(r.status,200,await r.text());
 act('fixture');sqlite.exec('UPDATE r1_schema_state SET open_gate=0');assert.equal((await access.POST(request('/api/access',{action:'activate'}))).status,503);
 sqlite.exec('UPDATE r1_schema_state SET open_gate=1');r=await access.POST(request('/api/access',{action:'activate'}));assert.equal(r.status,200,await r.text());
 assert.equal((await memberContext()).member.role,'hr');
 sqlite.exec("UPDATE r1_schema_state SET phase='read_switched'");act('owner');c=await memberContext();r=await hris.POST(request('/api/hris',{revision:c.row.revision,command:{action:'org',name:'旧客户端写',parentId:'',city:'上海',leader:'',status:'启用'}}));assert.equal(r.status,409);
 sqlite.close();
});
