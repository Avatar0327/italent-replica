import {memberGrants} from './r1-grants';
import {HttpError} from './http';
import {datasetDefinition,type ReportField} from './r1-report-catalog';
import type {Grant} from './r1-authorization';
import type {ReportContext} from './r1-report-context';
/** Complete tuples are evaluated in SQL before data/aggregation. Current person organization protects historical values. */
export async function reportPolicy(ctx:ReportContext,datasetId:string,action='read',history=false){
 const dataset=datasetDefinition(datasetId);if(!dataset)throw new HttpError(400,'未注册数据集','DATASET_NOT_FOUND');
 if(dataset.producer.startsWith('M07')&&!['admin','payroll_editor','payroll_reviewer'].includes(ctx.member.role))throw new HttpError(403,'仅当前薪酬专岗可访问管理报表','PAYROLL_ROLE_REQUIRED');
 const grants=await memberGrants(ctx.db,ctx.member.tenantId,ctx.member.userId,'M32',datasetId+'.'+action),sourceGrants=await memberGrants(ctx.db,ctx.member.tenantId,ctx.member.userId,dataset.producer.split('+')[0],action==='aggregate'?'aggregate':'read'),at=new Date().toISOString(),valid=(g:Grant)=>g.historyMode===(history?'history':'current')&&g.validFrom<=at&&(!g.validTo||g.validTo>at),current=grants.filter(valid),sources=sourceGrants.filter(valid);
 const fields=new Set(dataset.fields.filter(f=>current.some(g=>g.fields.includes(f.fieldId))).map(f=>f.fieldId));if(!current.some(g=>g.fields.includes('record')))throw new HttpError(403,'没有该报表动作权限','FORBIDDEN');
 const args:unknown[]=[];
 const org="CASE WHEN r.policy_kind='person' THEN COALESCE((SELECT p.org_id FROM r1_m01_entities p WHERE p.tenant_id=r.tenant_id AND p.id=r.person_id AND p.kind='person'),(SELECT e.org_id FROM hris_employees e WHERE e.tenant_id=r.tenant_id AND e.id=r.person_id)) ELSE r.org_id END";
 const tuple=(list:Grant[],field:string)=>{const matches=list.filter(g=>g.fields.includes(field));if(!matches.length)return '0';const clauses=matches.map(g=>{args.push(JSON.stringify(g.scope));let relation='0';if(g.relationType==='scope')relation='1';else if(g.relationType==='self'){args.push(ctx.member.employeeId??'');relation='r.person_id=?';}else {args.push(ctx.member.employeeId??'',g.relationType,at,at);relation='EXISTS(SELECT 1 FROM r1_relationships rel WHERE rel.tenant_id=r.tenant_id AND rel.manager_person_id=? AND rel.subject_person_id=r.person_id AND rel.relation_type=? AND rel.valid_from<=? AND (rel.valid_to IS NULL OR rel.valid_to>?))';}return '('+org+' IN (SELECT value FROM json_each(?)) AND '+relation+')';});return '('+clauses.join(' OR ')+')';};
 const predicate=(field:string)=>{const a=tuple(current,field),sourceField=field==='workforce.c07'?'email':field==='workforce.c08'?'level':'record';return '('+a+' AND '+tuple(sources,sourceField)+')';};
 const relationEnd=await ctx.db.prepare('SELECT min(valid_to) AS expires FROM r1_relationships WHERE tenant_id=? AND manager_person_id=? AND valid_from<=? AND valid_to>?').bind(ctx.member.tenantId,ctx.member.employeeId??'',at,at).first<{expires:string|null}>();if(relationEnd?.expires)ctx.member.permissionValidUntil=Math.min(ctx.member.permissionValidUntil??Number.MAX_SAFE_INTEGER,Date.parse(relationEnd.expires));
 const bounds=[...current,...sources].filter(g=>g.validTo).map(g=>Date.parse(g.validTo!));if(bounds.length)ctx.member.permissionValidUntil=Math.min(ctx.member.permissionValidUntil??Number.MAX_SAFE_INTEGER,...bounds);
 return {scopeOrgs:[...new Set(current.filter(g=>g.fields.includes('record')).flatMap(g=>g.scope))],fields,predicate,args,dataset,orgExpression:org,fieldDefinition:(id:string)=>dataset.fields.find(f=>f.fieldId===id) as ReportField};
}
