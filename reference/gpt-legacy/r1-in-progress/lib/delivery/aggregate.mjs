export const statuses=['已完成','进行中','待验证','阻塞','未开始'];
export function aggregate(scope,queue){
 const rows=scope.acceptanceTasks.map(t=>{
  const execution=queue.controllerQueue.find(q=>q.id===t.queueRef);
  const accepted=t.criteria.length>0&&t.criteria.every(c=>c.accepted&&c.acceptedBy&&c.acceptedAt&&c.evidence);
  const raw=execution?.status??'';
  const status=accepted?'已完成':raw.includes('blocked')?'阻塞':/technical|tested|published|synthetic-tested/.test(raw)?'待验证':/progress|partial/.test(raw)?'进行中':'未开始';
  return {...t,execution,status,accepted:Boolean(accepted)};
 });
 const count=items=>({total:items.length,accepted:items.filter(t=>t.accepted).length,percent:items.length?Math.round(items.filter(t=>t.accepted).length/items.length*1000)/10:null,counts:Object.fromEntries(statuses.map(s=>[s,items.filter(t=>t.status===s).length]))});
 return {tasks:rows,...count(rows),phases:['P1','P2','P3'].map(id=>({id,...count(rows.filter(t=>t.phase===id))})),blockers:queue.controllerQueue.filter(q=>q.status.includes('blocked'))};
}
