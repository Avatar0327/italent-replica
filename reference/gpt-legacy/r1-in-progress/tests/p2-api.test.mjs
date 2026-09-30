import {database,act,request} from './support/runtime.mjs';
import {readdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {businessDate}=await import('../lib/hris/business-time.ts');
const access=await import('../app/api/access/route.ts');
const hris=await import('../app/api/hris/route.ts');
const members=await import('../app/api/members/route.ts');
const storage=await import('../app/api/storage/route.ts');
const history=await import('../app/api/history/route.ts');
const audit=await import('../app/api/audit/route.ts');
const {readWorkspace,commitState}=await import('../lib/hris/repository.ts');
const {applyCommand,initialState}=await import('../lib/hris/model.ts');
function fresh(){const {db,sqlite}=database();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('drizzle/'+f,'utf8'));globalThis.p2env.DB=db;return {db,sqlite};}
async function expect(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function state(){return expect(await hris.GET());}
async function command(c){const data=await state();return expect(await hris.POST(request('/api/hris',{revision:data.revision,command:c})));}
async function grant(input){act('owner');const data=await expect(await members.GET());return expect(await members.POST(request('/api/members',{revision:data.revision,name:input.email,...input})));}
async function activate(id){act(id);return expect(await access.POST(request('/api/access',{action:'activate'})));}
test('P2 API：企业初始化、组织员工、成员范围、顺序审批、任职历史、越权和刷新持久化',async()=>{
 const {db,sqlite}=fresh();act('outsider');await expect(await access.POST(request('/api/access',{action:'setup',name:'测试集团'})),403);act('owner');await expect(await access.POST(request('/api/access',{action:'setup',name:'测试集团'})));await expect(await access.POST(request('/api/access',{action:'setup',name:'重复企业'})),409);
 await command({action:'org',name:'集团',parentId:'',city:'上海',leader:'',status:'启用'});let s=(await state()).state;const root=s.orgs[0].id;
 await command({action:'org',name:'部门甲',parentId:root,city:'上海',leader:'',status:'启用'});await command({action:'org',name:'部门乙',parentId:root,city:'北京',leader:'',status:'启用'});s=(await state()).state;const a=s.orgs.find(o=>o.name==='部门甲').id,b=s.orgs.find(o=>o.name==='部门乙').id;
 await command({action:'org',name:'甲子部门',parentId:a,city:'上海',leader:'',status:'启用'});s=(await state()).state;const child=s.orgs.find(o=>o.name==='甲子部门').id;
 await command({action:'employee',code:'001',name:'合成人员甲',orgId:child,job:'工程师',level:'P6',joined:'2026-09-01',email:'private-a@example.com'});await command({action:'employee',code:'002',name:'合成人员乙',orgId:b,job:'工程师',level:'P7',joined:'2026-09-01',email:'private-b@example.com'});s=(await state()).state;const e=s.employees.find(e=>e.code==='001'),other=s.employees.find(e=>e.code==='002');
 await grant({email:'hr@example.com',role:'hr',employeeId:null,active:true,orgScope:[a],viewEmail:false,viewLevel:false});await activate('hr');let scoped=await state();assert.deepEqual(scoped.state.employees.map(e=>e.id),[e.id]);assert.equal(scoped.state.employees[0].email,'');assert.equal(scoped.state.employees[0].level,'');
 await expect(await hris.POST(request('/api/hris',{revision:scoped.revision,command:{action:'employee',...other,name:'越权修改'}})),403);
 await expect(await hris.POST(request('/api/hris',{revision:scoped.revision,command:{action:'employee',...e,email:'hacked@example.com'}})),403);
 await command({action:'employee',...scoped.state.employees[0],name:'合成甲改名'});act('owner');s=(await state()).state;assert.equal(s.employees.find(x=>x.id===e.id).email,e.email);assert.equal(s.employees.find(x=>x.id===e.id).level,'P6');
 await grant({email:'reviewer@example.com',role:'approver',employeeId:null,active:true,orgScope:[a],viewEmail:false,viewLevel:false});await activate('reviewer');assert.equal((await state()).state.employees.length,0);
 await grant({email:'manager@example.com',role:'manager',employeeId:null,active:true,orgScope:[root],viewEmail:false,viewLevel:true});await activate('manager');assert.equal((await state()).state.employees.length,2);
 act('owner');await command({action:'workflow',kind:'regularize',steps:[{userId:'reviewer',name:'伪造名称'},{userId:'manager',name:'伪造名称'}]});
 act('hr');await command({action:'request',employeeId:e.id,kind:'regularize',orgId:'',reason:'试用考核完成'});const pending=(await state()).state.approvals.find(a=>a.employeeId===e.id);assert.notEqual(pending.steps[0].name,'伪造名称');
 act('owner');await command({action:'workflow',kind:'regularize',steps:[{userId:'manager',name:'经理'}]});assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_workflows').get().n,2);assert.equal((await state()).state.approvals.find(x=>x.id===pending.id).steps.length,2);act('manager');let d=await state();await expect(await hris.POST(request('/api/hris',{revision:d.revision,command:{action:'decide',id:pending.id,decision:'approved'}})),403);
 act('reviewer');await command({action:'decide',id:pending.id,decision:'approved'});assert.equal((await state()).state.employees[0].status,'试用');act('manager');await command({action:'decide',id:pending.id,decision:'approved'});act('owner');assert.equal((await state()).state.employees.find(x=>x.id===e.id).status,'正式');
 const hist=await expect(await history.GET(request('/api/history?employeeId='+e.id)));assert.equal(hist.total,2);assert.equal(hist.items[0].toStatus,'正式');
 act('hr');await expect(await history.GET(request('/api/history?employeeId='+other.id)),403);
 await grant({email:'employee@example.com',role:'employee',employeeId:e.id,active:true,orgScope:[],viewEmail:true,viewLevel:false});await activate('employee');d=await state();assert.equal(d.state.employees.length,1);assert.equal(d.state.employees[0].email,e.email);assert.equal(d.state.employees[0].level,'');await expect(await members.GET(),403);await expect(await audit.GET(request('/api/audit')),403);
 await grant({email:'hr@example.com',role:'hr',employeeId:null,active:false,orgScope:[a],viewEmail:false,viewLevel:false});act('hr');await expect(await hris.GET(),403);
 act('owner');const logs=await expect(await audit.GET(request('/api/audit?q=配置成员')));assert.ok(logs.total>=4);const literal=await expect(await audit.GET(request('/api/audit?q=%25')));assert.equal(literal.total,0);const tenant=sqlite.prepare('SELECT owner FROM hris_workspaces').get().owner;assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_employees').get().n,2);assert.deepEqual(JSON.parse(sqlite.prepare('SELECT data FROM hris_workspaces').get().data).employees,[]);assert.equal(JSON.parse((await readWorkspace(db,tenant)).data).employees.length,2);sqlite.close();
});
test('P2 存储：迁移保留原快照、重入不重复、跨租户外键、并发冲突与失败整体回滚',async()=>{
 const {db,sqlite}=fresh();const legacy=initialState();sqlite.prepare('INSERT INTO hris_workspaces(owner,data) VALUES (?,?)').run('legacy',JSON.stringify(legacy));sqlite.prepare("INSERT INTO hris_memberships(user_id,tenant_id,role,active) VALUES ('owner','legacy','admin',1)").run();act('owner');await expect(await storage.POST(request('/api/storage',{action:'migrate'})));await expect(await storage.POST(request('/api/storage',{action:'migrate'})));let row=await readWorkspace(db,'legacy');assert.equal(row.storageVersion,1);assert.equal(JSON.parse(row.data).employees.length,12);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_employment_history').get().n,12);assert.equal(sqlite.prepare('SELECT data FROM hris_workspaces').get().data,JSON.stringify(legacy));
 const before=JSON.parse(row.data);const member={userId:'owner',tenantId:'legacy',role:'admin',active:true,employeeId:null};const next=applyCommand(before,{action:'employee',...before.employees[0],name:'首个并发写'},undefined,'owner');assert.equal(await commitState(db,member,row.revision,before,next),true);const stale=applyCommand(before,{action:'employee',...before.employees[0],name:'过期写入'},undefined,'owner');assert.equal(await commitState(db,member,row.revision,before,stale),false);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_audit_events WHERE id=?').get(stale.audit[0].id).n,0);
 row=await readWorkspace(db,'legacy');const invalid=applyCommand(JSON.parse(row.data),{action:'employee',...before.employees[0],name:'应回滚'},undefined,'owner');invalid.employees[0].orgId='missing-org';await assert.rejects(()=>commitState(db,member,row.revision,JSON.parse(row.data),invalid));assert.equal((await readWorkspace(db,'legacy')).revision,row.revision);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_audit_events WHERE id=?').get(invalid.audit[0].id).n,0);
 const auditFail=applyCommand(JSON.parse(row.data),{action:'employee',...before.employees[0],name:'审计失败必须回滚'},undefined,'owner');sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");await assert.rejects(()=>commitState(db,member,row.revision,JSON.parse(row.data),auditFail));assert.equal((await readWorkspace(db,'legacy')).revision,row.revision);sqlite.exec('DROP TRIGGER fail_audit');
 sqlite.prepare('INSERT INTO hris_workspaces(owner,data,storage_version) VALUES (?,?,1)').run('another','{}');assert.throws(()=>sqlite.prepare('INSERT INTO hris_employees(tenant_id,id,code,name,org_id,job,level,joined,status,email) VALUES (?,?,?,?,?,?,?,?,?,?)').run('another','x','x','x',legacy.orgs[0].id,'x','x','2026-09-01','试用',''));
 sqlite.close();
});

test('P2 权限竞争：数据快照之前撤销组织范围不沿用旧权限',async()=>{
 const {db,sqlite}=fresh();const legacy=initialState();sqlite.prepare('INSERT INTO hris_workspaces(owner,data) VALUES (?,?)').run('race',JSON.stringify(legacy));sqlite.prepare("INSERT INTO hris_memberships(user_id,tenant_id,role,active,org_scope) VALUES ('hr','race','hr',1,'[\"o1\"]')").run();let once=true;
 globalThis.p2env.DB={...db,batch:async statements=>{if(once&&statements[0].sql.startsWith('SELECT data,revision')){once=false;sqlite.prepare("UPDATE hris_memberships SET org_scope='[]' WHERE user_id='hr'").run();sqlite.prepare("UPDATE hris_workspaces SET revision=revision+1 WHERE owner='race'").run();}return db.batch(statements);}};
 act('hr');const result=await state();assert.equal(result.revision,1);assert.equal(result.state.employees.length,0);assert.equal(result.state.orgs.length,0);sqlite.close();
});
test('P3 岗位与职级：目录关联、任职变更审批、在用保护及历史留存',async()=>{
 const {sqlite}=fresh();act('owner');await expect(await access.POST(request('/api/access',{action:'setup',name:'岗位测试企业'})));
 await command({action:'org',name:'研发中心',parentId:'',city:'上海',leader:'',status:'启用'});const org=(await state()).state.orgs[0];
 await command({action:'grade',code:'P6',name:'高级工程师',sequence:6,status:'启用'});await command({action:'grade',code:'P7',name:'专家',sequence:7,status:'启用'});
 await command({action:'position',code:'RD01',name:'软件工程师',orgId:org.id,family:'研发',responsibilities:'系统开发与维护',status:'启用'});
 let s=(await state()).state;const position=s.positions[0],g6=s.grades.find(g=>g.code==='P6'),g7=s.grades.find(g=>g.code==='P7');
 await command({action:'employee',code:'E1',name:'合成任职人',orgId:org.id,positionId:position.id,gradeId:g6.id,job:'错误客户端名称',level:'错误客户端职级',joined:'2026-09-01',email:''});s=(await state()).state;const e=s.employees[0];assert.equal(e.job,position.name);assert.equal(e.level,g6.name);assert.equal(e.positionId,position.id);
 let d=await state();await expect(await hris.POST(request('/api/hris',{revision:d.revision,command:{action:'employee',...e,gradeId:g7.id}})),400);
 await expect(await hris.POST(request('/api/hris',{revision:d.revision,command:{action:'position',...position,status:'停用'}})),400);
 await grant({email:'reviewer@example.com',role:'approver',employeeId:null,active:true,orgScope:[org.id],viewLevel:true,viewEmail:false});await activate('reviewer');await grant({email:'reviewer2@example.com',role:'approver',employeeId:null,active:true,orgScope:[org.id],viewLevel:true,viewEmail:false});await activate('reviewer2');act('owner');await command({action:'workflow',kind:'transfer',steps:[{userId:'reviewer',name:'调出复核'},{userId:'reviewer2',name:'调入复核'}]});
 await command({action:'request',employeeId:e.id,kind:'transfer',effectiveOn:businessDate(),orgId:org.id,positionId:position.id,gradeId:g7.id,reason:'通过岗位能力评定，申请晋级'});d=await state();const approval=d.state.approvals[0];assert.equal(d.state.employees[0].level,g6.name);
 await expect(await hris.POST(request('/api/hris',{revision:d.revision,command:{action:'grade',...g7,status:'停用'}})),400);
 act('reviewer');d=await state();assert.equal(d.state.employees[0].gradeId,g6.id);assert.equal(d.state.approvals[0].details.transfer.target.gradeId,g7.id);await command({action:'decide',id:approval.id,decision:'approved'});act('reviewer2');await command({action:'decide',id:approval.id,decision:'approved'});act('owner');assert.equal((await state()).state.employees[0].gradeId,g6.id);await command({action:'executeTransfer',id:approval.id});
 act('owner');s=(await state()).state;assert.equal(s.employees[0].gradeId,g7.id);assert.equal(s.employees[0].level,g7.name);const hist=await expect(await history.GET(request('/api/history?employeeId='+e.id)));assert.equal(hist.total,2);assert.equal(hist.items[0].level,g7.name);
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_employee_positions').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hris_assignment_requests').get().n,1);sqlite.close();
});
