import {authorizeTuple} from './r1-authorization';
import {receiveEvent,type SourceContract} from './r1-integration';
import type {CommandIntent} from './r1-command';
import type {memberContext} from './context';
/** Consumer checkpoint and invalidation are atomic. Reads always recheck source versions and current rights. */
export async function invalidatePortal(ctx:Awaited<ReturnType<typeof memberContext>>,intent:CommandIntent,envelope:unknown,contract:SourceContract,orgId:string){
 await authorizeTuple(ctx.db,ctx.member,{objectType:'BASE',action:'integration.consume',orgId,personId:'',field:'record',historyMode:'current'});
 return receiveEvent(ctx.db,ctx.member,intent,envelope,contract,(token,e)=>[
  ctx.db.prepare('INSERT INTO r1_portal_invalidations SELECT owner,?,?,?,?,revision FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,source,source_id) DO UPDATE SET event_id=excluded.event_id,source_revision=excluded.source_revision,workspace_revision=excluded.workspace_revision').bind(e.source,e.internalId,e.eventId,e.entityRevision,ctx.member.tenantId,token),
  ctx.db.prepare('DELETE FROM r1_portal_cursors WHERE tenant_id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(ctx.member.tenantId,ctx.member.tenantId,token),
 ],'M48.portal');
}
