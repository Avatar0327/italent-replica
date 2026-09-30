import {z} from 'zod';
import {digest} from './r1-command';
import {HttpError} from './http';
import type {Entity} from './r1-m01';
export const identityKey=z.object({type:z.enum(['code','document','phone','email']),value:z.string().trim().min(1).max(200)}).strict();
export type IdentityKey=z.infer<typeof identityKey>;
export async function resolveIdentity(db:D1Database,tenant:string,keys:IdentityKey[]){
 const ids=new Set<string>();
 for(const key of keys){
  const hash=await digest({tenantId:tenant,type:key.type,value:key.value});
  const result=await db.prepare('SELECT person_id AS personId FROM r1_identity_keys WHERE tenant_id=? AND identifier_type=? AND value_digest=? LIMIT 3').bind(tenant,key.type,hash).all<{personId:string}>();
  for(const r of result.results)ids.add(r.personId);
  // Retained exact case-sensitive legacy employee code is a stable key; names, email and phone are not.
  if(key.type==='code'){const r=await db.prepare("SELECT id FROM r1_m01_entities WHERE tenant_id=? AND kind='person' AND code=?").bind(tenant,key.value).first<{id:string}>();if(r)ids.add(r.id);}
 }
 return [...ids].sort();
}
export async function prepareIdentityKeys(tenant:string,keys:IdentityKey[]){return Promise.all(keys.map(async k=>({type:k.type,digest:await digest({tenantId:tenant,type:k.type,value:k.value})})));}
export function captureR1ContractFields(definitions:Entity[],input:Record<string,string|null>,previous?:Entity){
 const active=definitions.filter(d=>d.status==='active');if(active.length>20)throw new HttpError(400,'每组织最多20项合同字段','FIELD_LIMIT');
 if(Object.keys(input).some(k=>!active.some(d=>d.id===k)))throw new HttpError(400,'合同字段不属于当前有效定义','FIELD_VERSION_CONFLICT');
 return active.map(d=>{
  const old=previous?.payload.fieldSnapshots?.find((f:any)=>f.rootId===d.id);
  const base={id:d.id,rootId:d.id,version:d.revision,code:d.code,name:d.payload.name,inheritPrevious:d.payload.inheritPrevious};
  if(Object.hasOwn(input,d.id))return {...base,value:input[d.id],source:'manual'};
  if(d.payload.inheritPrevious&&old)return {...base,value:old.value,source:'inherited',sourceContractId:previous!.id,sourceFieldVersion:old.version};
  return {...base,value:null,source:'empty'};
 });
}
/** One stable contract ID counts once across versions and rehire; unknown categories stay outside the number. */
export function contractCounts(contracts:Entity[]){
 const latest=new Map<string,Entity>();for(const c of contracts)if(!latest.has(c.id)||latest.get(c.id)!.revision<c.revision)latest.set(c.id,c);
 const groups=new Map<string,{personId:string|null;legalEntityId:string;agreementCategory:string;count:number;contractIds:string[]}>();const unknownIds:string[]=[];
 for(const c of latest.values()){
  if(!['signed','ended'].includes(c.status))continue;
  if(!c.payload.agreementCategory||!c.payload.legalEntityId){unknownIds.push(c.id);continue;}
  const key=JSON.stringify([c.personId,c.payload.legalEntityId,c.payload.agreementCategory]);
  const group=groups.get(key)??{personId:c.personId,legalEntityId:c.payload.legalEntityId,agreementCategory:c.payload.agreementCategory,count:0,contractIds:[] as string[]};group.count++;group.contractIds.push(c.id);groups.set(key,group);
 }
 return {groups:[...groups.values()],unknownIds,historyQuality:unknownIds.length?'unknown':'known',automaticOpenEnded:false,automaticTermination:false};
}
