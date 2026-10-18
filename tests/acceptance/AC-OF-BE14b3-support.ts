/**
 * BE-14b3 第 1 轮审查返工夹具：编辑并同步的推送断言（目标快照、映射镜像）。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { type SyncOffer, type SyncWorld } from './AC-OF-BE14b2-support.js';

export const rows = <T>(result: unknown) =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
export type Edited = SyncOffer & { entrySync?: string };

export async function edited(w: SyncWorld, offer: Pick<SyncOffer, 'id' | 'revision'>, body: Record<string, unknown>) {
  const response = await w.request('PUT', `/${offer.id}`, { ifMatch: offer.revision, body });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Edited;
}

/** 目标（员工 / 任职 / 待入职合同 / 审计）此刻的完整快照：用于断言“整笔没写”。 */
export async function targetState(w: SyncWorld, offerId: string) {
  const entryId = (await w.read(offerId)).pendingEntryBusinessId!;
  const employeeId = (await w.record(entryId)).employeeId;
  const query = async <T>(text: ReturnType<typeof sql>) =>
    rows<T>(await withTenant(w.db, w.tenant.id, (tx) => tx.execute(text)));
  return {
    entryId,
    profile: await query(sql`SELECT revision, name, email FROM personnel_employee_versions
      WHERE employee_id = ${employeeId}::uuid ORDER BY revision`),
    audits: await query(sql`SELECT count(*)::int AS n FROM audit_events
      WHERE object_id IN (${employeeId}, ${entryId})`),
    contract: await query(sql`SELECT start_date::text, end_date::text, contract_company_id::text
      FROM employment_pending_entry_contract WHERE business_id = ${entryId}::uuid`),
    record: await w.record(entryId),
    entries: [...(await w.entries('all')), ...(await w.entries('cancelled'))].filter(
      (e) => e.employeeId === employeeId,
    ),
  };
}

/** 成功回执之后，目标上的各类映射都应与 Offer 当前值一致（员工姓名、入职日、任职地点、试用期、合同起止）。 */
export async function expectMirrors(w: SyncWorld, offerId: string) {
  const offer = await w.read(offerId);
  const entry = await w.entryOf(offer);
  const record = await w.record(entry.id);
  expect(entry).toMatchObject({
    name: offer.name,
    effectiveDate: offer.plannedEntryDate,
    probation: offer.hasProbation,
    contractStartDate: offer.plannedEntryDate,
    contractEndDate: offer.contractEndDate,
  });
  expect(record.fields.place).toBe(offer.workPlace);
}
