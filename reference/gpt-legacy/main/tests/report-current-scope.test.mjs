import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,expect,get,request,members} from './support/foundation-scenario.mjs';
import {moveEmployee} from './support/performance-scenario.mjs';
const reports=await import('../app/api/reports/route.ts'),portal=await import('../app/api/self-service/route.ts');
const read=async(status=200)=>expect(await reports.GET(request('/api/reports?dataset=workforce')),status);
test('report reads and exports use current organization scope and revoked account cannot export',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());act('manager');
 let report=await read();assert.equal(report.total,1);assert.ok(JSON.stringify(report.rows).includes(f.e.name));assert.ok(!JSON.stringify(report.rows).includes(f.other.name));
 await moveEmployee(f,'transfer');act('manager');report=await read();assert.equal(report.total,0);
 const empty=await reports.POST(request('/api/reports',{revision:(await get()).revision,query:{dataset:'workforce'}}));assert.equal(empty.status,200);assert.ok(!(await empty.text()).includes(f.e.name));
 act('employee');const self=await expect(await portal.GET());assert.equal(self.employee.id,f.e.id);assert.equal(self.employee.orgId,f.otherOrg.id);
 act('owner');const revision=(await expect(await members.GET())).revision;
 await expect(await members.POST(request('/api/members',{revision,email:'manager@example.com',name:'manager',role:'manager',employeeId:null,orgScope:[f.org.id],viewEmail:false,viewLevel:false,active:false})));
 const after=(await get()).revision,audits=f.sqlite.prepare('SELECT COUNT(*) AS n FROM hris_audit_events').get().n;
 act('manager');await read(403);await expect(await reports.POST(request('/api/reports',{revision:after,query:{dataset:'workforce'}})),403);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM hris_audit_events').get().n,audits);
 act('owner');assert.equal((await get()).revision,after);assert.equal((await read()).total,2);
});
