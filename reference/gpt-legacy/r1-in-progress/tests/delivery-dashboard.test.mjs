import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {aggregate} from '../lib/delivery/aggregate.mjs';
const scope=JSON.parse(readFileSync(new URL('../docs/delivery/Scope_Register.json',import.meta.url)));
const queue=JSON.parse(readFileSync(new URL('../docs/delivery/Module_Queue.json',import.meta.url)));
test('scope retains all 48 modules and every task has a unique link and existing module',()=>{
 assert.equal(scope.modules.length,48);assert.equal(new Set(scope.acceptanceTasks.map(t=>t.id)).size,scope.acceptanceTasks.length);
 for(const t of scope.acceptanceTasks){assert.ok(scope.modules.some(m=>m.id===t.moduleId));assert.ok(t.criteria.length);if(t.queueRef)assert.ok(queue.controllerQueue.some(q=>q.id===t.queueRef));}
});
test('publication and technical delivery never count as acceptance',()=>{
 const m=aggregate(scope,queue);assert.equal(m.accepted,0);assert.equal(Object.values(m.counts).reduce((a,b)=>a+b,0),m.total);
 assert.equal(m.phases.reduce((a,b)=>a+b.total,0),m.total);assert.equal(m.phases.find(p=>p.id==='P1').percent,0);
 assert.equal(m.phases.find(p=>p.id==='P1').total,8);
 const empty=structuredClone(scope);empty.acceptanceTasks=empty.acceptanceTasks.filter(t=>t.phase!=='P1');
 assert.equal(aggregate(empty,queue).phases.find(p=>p.id==='P1').percent,null);
 assert.ok(m.tasks.filter(t=>t.execution?.status.includes('published')).every(t=>t.status==='待验证'));
});
test('only all criteria with signed evidence count; adding scope changes denominator',()=>{
 const s=structuredClone(scope),t=s.acceptanceTasks[0];t.criteria[0].accepted=true;
 assert.equal(aggregate(s,queue).accepted,0);
 Object.assign(t.criteria[0],{acceptedBy:'合成验收人',acceptedAt:'2026-09-08T00:00:00Z',evidence:'synthetic acceptance'});
 assert.equal(aggregate(s,queue).accepted,1);
 t.criteria.push({id:'synthetic-second',text:'second condition',accepted:false});assert.equal(aggregate(s,queue).accepted,0);
 const n=s.acceptanceTasks.length;s.acceptanceTasks.push({...structuredClone(t),id:'synthetic-extra'});assert.equal(aggregate(s,queue).total,n+1);
});
test('queue changes immediately affect aggregation without dashboard status edits',()=>{
 const q=structuredClone(queue),id=scope.acceptanceTasks.find(t=>t.queueRef).queueRef;
 q.controllerQueue.find(t=>t.id===id).status='blocked-test';assert.equal(aggregate(scope,q).tasks.find(t=>t.queueRef===id).status,'阻塞');
 q.controllerQueue.find(t=>t.id===id).status='in-progress';assert.equal(aggregate(scope,q).tasks.find(t=>t.queueRef===id).status,'进行中');
});

test('missing execution evidence does not imply technical completion or awaiting verification',()=>{
 const s=structuredClone(scope);const t=s.acceptanceTasks[0];delete t.queueRef;
 assert.equal(aggregate(s,queue).tasks[0].status,'未开始');
 const l04=aggregate(scope,queue).tasks.find(t=>t.id==='L04');assert.equal(l04.status,'阻塞');assert.equal(l04.accepted,false);
});
