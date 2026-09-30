import {HttpError} from './http';
import type {Entity} from './r1-m01';

export const previousDay=(day:string)=>new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
export function effectiveVersions(versions:Entity[]):Entity[]{
 const superseded=new Set(versions.filter(v=>Number.isSafeInteger(v.payload.supersedesVersion)).map(v=>v.id+':'+v.payload.supersedesVersion));
 return versions.filter(v=>!superseded.has(v.id+':'+v.revision));
}
/** Page through immutable versions; reject instead of silently truncating a temporal graph. */
export async function catalogTimeline(db:D1Database,tenant:string,kind:string){
 const output:Entity[]=[];let after='';
 for(let page=0;page<50;page++){
  const result=await db.prepare(`SELECT e.id,e.kind,e.person_id AS personId,e.org_id AS orgId,e.code,e.revision,e.status,e.payload FROM r1_m01_entities e WHERE e.tenant_id=? AND e.kind=? AND e.id>? ORDER BY e.id LIMIT 100`).bind(tenant,kind,after).all<any>();
  for(const entity of result.results){
   const history=await db.prepare('SELECT payload FROM r1_m01_versions WHERE tenant_id=? AND entity_id=? ORDER BY version LIMIT 501').bind(tenant,entity.id).all<{payload:string}>();
   if(history.results.length>500)throw new HttpError(503,'目录历史需要分片核验','BOUNDED_QUERY_REQUIRED');
   const versions=history.results.map(r=>JSON.parse(r.payload) as Entity);
   if(!versions.some(v=>v.revision===entity.revision))versions.push({...entity,payload:JSON.parse(entity.payload)});
   output.push(...effectiveVersions(versions));
  }
  if(result.results.length<100)return output;after=result.results.at(-1)!.id;
 }
 throw new HttpError(503,'目录图超过本轮安全边界','BOUNDED_QUERY_REQUIRED');
}
export function temporalCatalogCheck(versions:Entity[],kind:string){
 const cuts=[...new Set(versions.flatMap(v=>[v.payload.validFrom,...(v.payload.validTo?[new Date(Date.parse(v.payload.validTo+'T00:00:00Z')+86400000).toISOString().slice(0,10)]:[])].filter(Boolean)))].sort();
 for(const day of cuts){
  const active=versions.filter(v=>v.payload.validFrom<=day&&(!v.payload.validTo||v.payload.validTo>=day));
  const byId=new Map<string,Entity>();const names=new Set<string>();
  for(const v of active){
   if(byId.has(v.id))throw new HttpError(400,'有效版本区间重叠','INTERVAL_CONFLICT');byId.set(v.id,v);
   if(kind==='position'||kind==='org'){
    const key=JSON.stringify([kind==='position'?v.orgId:v.payload.parentId,v.payload.name]);
    if(names.has(key))throw new HttpError(400,'同范围有效区间名称冲突','NAME_CONFLICT');names.add(key);
   }
  }
  for(const v of active){
   const seen=new Set<string>();let next:Entity|undefined=v;
   while(next){if(seen.has(next.id))throw new HttpError(400,'目录上下级形成时态环','TEMPORAL_CYCLE');seen.add(next.id);
    const parent=next.payload.parentId;if(!parent)break;
    next=byId.get(parent);if(!next)throw new HttpError(400,'上级目录在有效区间不存在','PARENT_NOT_EFFECTIVE');
   }
  }
 }
 return cuts;
}
