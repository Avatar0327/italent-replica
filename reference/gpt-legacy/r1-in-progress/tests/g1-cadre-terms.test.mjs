import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,expect,get,request,dev,grant} from './support/foundation-scenario.mjs';
const api=await import('../app/api/cadre-terms/route.ts'),profiles=await import('../app/api/cadre-profiles/route.ts');
async function post(command,status=200,revision){return expect(await api.POST(request('/api/cadre-terms',{revision:revision??(await get()).revision,command})),status);}
test('Cadre terms: scoped registration, immutable history, correction, ending and profile integration',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const base={action:'register',employeeId:f.e.id,orgId:f.org.id,positionId:f.position.id,appointmentType:'主职',start:'2026-01-01',expectedEnd:'2026-12-31',observationEnd:'2026-03-31',evidence:'合成任用凭证登记，不改变人事岗位'};
 act('hr');const initial=(await get()).revision,created=await post(base);
 await post({...base,action:'correct',id:created.id},409,initial);await post(base,400);
 await post({...base,employeeId:f.other.id},403);
 await post({...base,start:'2027-02-30',expectedEnd:'2027-12-31'},400);
 const rev=(await get()).revision;await post({...base,action:'correct',id:created.id,observationEnd:'2027-01-01'},400);assert.equal((await get()).revision,rev);
 await post({...base,action:'correct',id:created.id,expectedEnd:'2026-11-30',evidence:'合成更正依据：预计任期结束日期调整'});
 const profile=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+f.e.id)));assert.ok(profile.sections.find(s=>s.key==='terms').items.some(r=>r.id===created.id));
 act('manager');assert.ok((await expect(await api.GET())).records.some(r=>r.id===created.id));await post({...base,action:'void',id:created.id},403);
 act('employee');await expect(await api.GET(),403);await expect(await dev.GET(request('/api/development?id='+created.id)),403);
 await grant('outside','hr',null,[f.otherOrg.id]);act('outside');assert.equal((await expect(await api.GET())).records.length,0);await post({...base,action:'void',id:created.id},403);
 act('hr');await post({action:'end',id:created.id,actualEnd:'2026-05-01',endReason:'离职',evidence:'仍在职，不能以离职原因结束'},400);
 await post({action:'end',id:created.id,actualEnd:'2026-05-01',endReason:'免职',evidence:'合成免职凭证，员工仍在职'});
 await post({...base,action:'correct',id:created.id},400);
 const next=await post({...base,start:'2026-05-02',observationEnd:undefined,evidence:'合成再次任用，保留前一段任期'});
 await post({action:'void',id:next.id,evidence:'合成凭证撤销，保留作废过程'});
 const history=await expect(await dev.GET(request('/api/development?id='+created.id)));assert.ok(history.items.length>=3);
 assert.equal((await expect(await api.GET())).records.length,2);
});
