import assert from 'node:assert/strict';
import {get,expect,dev,act,request} from './foundation-scenario.mjs';
const profiles=await import('../../app/api/cadre-profiles/route.ts');
export const readProfile=async(employeeId,status=200)=>expect(await profilesResponse(employeeId),status);
// Await the route before handing it to the shared response assertion.
async function profilesResponse(employeeId){return profiles.GET(request('/api/cadre-profiles?employeeId='+employeeId));}
export async function checkProfile(employeeId,planId,enrollmentId,status,experienceId){
 const p=await expect(await profilesResponse(employeeId));
 for(const [key,id] of [['plans',planId],['learning',enrollmentId]])assert.equal(p.sections.find(s=>s.key===key).items.find(r=>r.id===id).status,status);
 if(experienceId)assert.ok(p.sections.find(s=>s.key==='experiences').items.some(r=>r.id===experienceId));
 return p;
}
export async function checkOutside(role,employeeId,ids){
 act(role);await expect(await profilesResponse(employeeId),403);
 const d=await get();for(const id of ids){assert.ok(!d.records.some(r=>r.id===id));await expect(await dev.GET(request('/api/development?id='+id)),403);}
}
