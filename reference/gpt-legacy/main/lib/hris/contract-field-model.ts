import type {DevelopmentRecord as R} from './development';
export type ContractFieldSnapshot={id:string;rootId:string;version:number;code:string;name:string;inheritPrevious:boolean;value:string|null;source:'manual'|'inherited'|'empty';sourceContractId?:string;sourceFieldVersion?:number};
export function activeContractFields(records:R[],orgId:string){
 const latest=new Map<string,R>();
 for(const r of records)if(r.kind==='contractFieldDefinition'&&r.payload.orgId===orgId&&(r.status==='sealed'||r.status==='archived'&&!!r.payload.publishedAt)){
  const root=r.payload.definitionRootId!;if(!latest.has(root)||(latest.get(root)!.payload.version??0)<(r.payload.version??0))latest.set(root,r);
 }
 return [...latest.values()].filter(r=>r.status==='sealed').sort((a,b)=>a.payload.contractField!.code.localeCompare(b.payload.contractField!.code));
}
export function contractFieldDefault(def:R,previous:R|undefined):Pick<ContractFieldSnapshot,'value'|'source'|'sourceContractId'|'sourceFieldVersion'>{
 const old=previous?.payload.contractFields?.find(f=>f.rootId===def.payload.definitionRootId);
 return def.payload.contractField?.inheritPrevious&&old?{value:old.value,source:'inherited',sourceContractId:previous!.id,sourceFieldVersion:old.version}:{value:null,source:'empty'};
}
