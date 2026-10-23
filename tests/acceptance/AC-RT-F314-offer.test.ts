/** DEC-675 方案 C：在途退休不误生实习转正，退休生效后走现有退休返聘待入职。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { stateSnapshot } from './AC-EXIT-gate-support.js';
import { errorOf } from './AC-OF-BE14a-support.js';
import { syncWorld, type SyncOffer } from './AC-OF-BE14b2-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const REASON = 'OFFER_SYNC_AWAITING_RETIREMENT';

async function setup(label: string, automatic: boolean, internConversion = true) {
  const w = await syncWorld(database().db, `f314-${label}`);
  await installExitSeeds(w.db, w.tenant.id);
  await w.timing({ enabled: automatic, internConversion });
  const employee = await w.internEmployee('合成待退休实习生');
  const current = await w.employment('GET', `/employees/${employee.id}`);
  const retirement = await w.employment('POST', `/retirements/employees/${employee.id}`, {
    ifMatch: ((await current.json()) as { revision: number }).revision,
    body: { mode: 'direct', lastWorkDate: '2026-10-25' },
  });
  expect(retirement.status, await retirement.clone().text()).toBe(201);
  const retire = (await retirement.json()) as { id: string; status: string };
  expect(retire.status).toBe('approved');
  const offer = await w.social({ personalEmail: loginEmailOf(employee.id), plannedEntryDate: '2026-10-27' });
  const linked = await w.request('POST', `/${offer.id}/link-employee`, {
    ifMatch: offer.revision,
    body: { employeeId: employee.id },
  });
  expect(linked.status).toBe(200);
  const accepted = await w.accepted((await linked.json()) as SyncOffer);
  const activate = exitActivator(w.db, w);
  return { ...w, employee, retire, accepted, activate };
}

describe('AC-RT-F314 Offer 等退休生效', () => {
  it.each([true, false])('手动同步精确 409、无产物；退休后重同步成功（实习开关 %s）', async (on) => {
    const w = await setup(`manual-${on}`, false, on);
    const before = await stateSnapshot(w.db, w.tenant.id, w.employee.id);
    const beforeOffer = await w.read(w.accepted.id);
    const response = await w.sync(beforeOffer);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: 'CONFLICT', details: { reason: REASON } });
    expect(await stateSnapshot(w.db, w.tenant.id, w.employee.id)).toEqual(before);
    expect(await w.read(w.accepted.id)).toEqual(beforeOffer);
    expect(await w.entries()).toEqual([]);
    expect(await w.activate(w.retire.id, '2026-10-26')).toMatchObject({ outcome: 'effective' });
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-26T04:00:00Z') });
    const synced = await api.request('POST', `/api/tenant/offers/${w.accepted.id}/sync`, {
      tenant: w.tenant.id,
      user: w.user.id,
      ifMatch: (await w.read(w.accepted.id)).revision,
      body: {},
    });
    expect(synced.status, await synced.clone().text()).toBe(200);
    const result = (await synced.json()) as SyncOffer;
    expect(result).toMatchObject({ syncStatus: 'success', syncTarget: 'pending_entry' });
    expect((await w.recordsOf(w.employee.id)).map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
    expect(await w.entryOf(result)).toMatchObject({ employeeId: w.employee.id, employeeStatus: 1 });
  });

  it.each([true, false])('自动失败不影响接受，次日退休生效后可重试（实习开关 %s）', async (on) => {
    const w = await setup(`auto-${on}`, true, on);
    expect(w.accepted).toMatchObject({
      status: 'accepted',
      syncStatus: 'failed',
      syncReason: REASON,
      syncAttempts: 1,
      pendingEntryBusinessId: null,
    });
    expect((await w.recordsOf(w.employee.id)).map((row) => row.kind)).toEqual(['hire']);
    expect(await w.entries()).toEqual([]);
    const sweep = (date: string) =>
      runOfferSyncSweep(w.db, { tenantId: w.tenant.id, clock: () => new Date(`${date}T05:00:00Z`) });
    expect(await sweep('2026-10-17')).toMatchObject({ synced: [], failed: [], errors: [] });
    expect(await sweep('2026-10-18')).toMatchObject({ synced: [], failed: [w.accepted.id], errors: [] });
    expect((await w.read(w.accepted.id)).syncAttempts).toBe(2);
    expect(await w.activate(w.retire.id, '2026-10-26')).toMatchObject({ outcome: 'effective' });
    expect(await sweep('2026-10-26')).toMatchObject({ synced: [w.accepted.id], failed: [], errors: [] });
    const result = await w.read(w.accepted.id);
    expect(result).toMatchObject({ syncAttempts: 3, syncStatus: 'success', syncReason: null });
    expect((await w.recordsOf(w.employee.id)).map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
    expect(await sweep('2026-10-27')).toMatchObject({ synced: [], failed: [], errors: [] });
    expect(await w.read(w.accepted.id)).toEqual(result);
  });
});
