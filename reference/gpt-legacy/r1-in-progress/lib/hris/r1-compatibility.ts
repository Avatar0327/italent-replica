import type {State} from './model';
import {catalogTimeline} from './r1-temporal';
import {businessDate} from './business-time';
/** Read-time catalog projection allows future versions to become visible without a hidden write. */
export async function projectR1Catalogs(db:D1Database,tenant:string,state:State,asOf=businessDate()):Promise<State>{
 const out=structuredClone(state);
 for(const kind of ['org','grade','position']){
  const versions=(await catalogTimeline(db,tenant,kind)).filter(e=>e.payload.validFrom<=asOf&&(!e.payload.validTo||e.payload.validTo>=asOf));
  for(const e of versions){const p=e.payload,status=e.status==='active'?'启用':'停用';
   if(kind==='org'){const row={id:e.id,name:p.name,parentId:p.parentId??'',city:p.attributes?.city??'',leader:p.attributes?.legacyLeader??'',status};const i=out.orgs.findIndex(x=>x.id===e.id);if(i<0)out.orgs.push(row);else out.orgs[i]=row;}
   if(kind==='position'){const row={id:e.id,code:e.code??'',name:p.name,orgId:e.orgId!,family:p.attributes?.familyId??'',responsibilities:p.attributes?.responsibilities??'',status};const list=out.positions??=[];const i=list.findIndex(x=>x.id===e.id);if(i<0)list.push(row);else list[i]=row;}
   if(kind==='grade'){const row={id:e.id,code:e.code??'',name:p.name,sequence:p.attributes?.sequence??0,status};const list=out.grades??=[];const i=list.findIndex(x=>x.id===e.id);if(i<0)list.push(row);else list[i]=row;}
  }
 }
 return out;
}
