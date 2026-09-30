// H001: reusable synthetic two-organization fixture, derived from existing P3 setup.
// In-memory SQLite only; call setup once per serial test and close sqlite in cleanup.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {database,act,request} from './runtime.mjs';
const access=await import('../../app/api/access/route.ts'),hris=await import('../../app/api/hris/route.ts'),members=await import('../../app/api/members/route.ts'),dev=await import('../../app/api/development/route.ts'),files=await import('../../app/api/attachments/route.ts');
async function expect(r,status=200){assert.equal(r.status,status,await r.clone().text());return r.json();}
async function get(){return expect(await dev.GET());}
async function send(command,status=200,revision){const d=await get();return expect(await dev.POST(request('/api/development',{revision:revision??d.revision,command})),status);}
async function core(command){const d=await expect(await hris.GET());return expect(await hris.POST(request('/api/hris',{revision:d.revision,command})));}
async function grant(id,role,employeeId,orgScope=[],existing=false){act('owner');const d=await expect(await members.GET());await expect(await members.POST(request('/api/members',{revision:d.revision,email:id+'@example.com',name:id,role,employeeId,orgScope,viewEmail:false,viewLevel:false,active:true})));act(id);if(!existing)await expect(await access.POST(request('/api/access',{action:'activate'})));act('owner');}
async function setup(){const {db,sqlite}=database();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('drizzle/'+f,'utf8'));globalThis.p2env.DB=db;act('owner');await expect(await access.POST(request('/api/access',{action:'setup',name:'人才学习测试企业'})));await core({action:'org',name:'研发',parentId:'',city:'上海',leader:'',status:'启用'});await core({action:'org',name:'财务',parentId:'',city:'北京',leader:'',status:'启用'});let state=(await expect(await hris.GET())).state;const org=state.orgs[0],otherOrg=state.orgs[1];await core({action:'position',code:'DEV',name:'工程师',orgId:org.id,family:'技术',responsibilities:'开发验证',status:'启用'});for(const [code,orgId]of[['A',org.id],['B',otherOrg.id]])await core({action:'employee',code,name:'合成员工'+code,orgId,job:'工程师',level:'',joined:'2026-01-01',email:''});state=(await expect(await hris.GET())).state;const e=state.employees.find(e=>e.code==='A'),other=state.employees.find(e=>e.code==='B');await grant('employee','employee',e.id);await grant('manager','manager',null,[org.id]);await grant('hr','hr',null,[org.id]);await grant('approver','approver',null,[org.id]);return {db,sqlite,e,other,org,otherOrg,position:state.positions[0]};}
const anchors=['能在指导下完成基础任务','能够独立处理常规工作任务','能够独立解决复杂业务问题','能够指导团队完善工作方法','能够建立组织级标准并推广'];
const due='2099-12-31';

export {access,hris,members,dev,expect,get,send,core,grant,setup,anchors,due,act,request};
