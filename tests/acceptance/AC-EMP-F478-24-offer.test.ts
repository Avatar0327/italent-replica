/** F-478 S6：Offer 同步产生的退休返聘待入职，办理入职时同样按开关累计（走 completeRehireSeniority 路径）。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { syncWorld, type SyncOffer } from './AC-OF-BE14b2-support.js';
import { tenantApi } from './support/tenant-api.js';
import { handTenure, putSetting, RETIRE_REHIRE_SETTING, seedSettings } from './AC-EMP-F478-seniority-support.js';

const database = useTestDb();

it.each([true, false])('AC-EMP-F478-24：Offer 同步退休返聘待入职，办理入职时开关 %s', async (on) => {
  await seedSettings(database().db);
  const w = await syncWorld(database().db, `f478-s6-offer-${on}`);
  await installExitSeeds(w.db, w.tenant.id);
  await w.timing({ enabled: false });
  const employee = await w.internEmployee('合成待返聘实习生');
  // 入职日 2026-10-17、最后工作日 2026-10-25：校正值取 1.95，使累计 1.95 + 8/365 → 1.9（可与“未改动 1.95”区分）
  const history = await w.employment('GET', `/employees/${employee.id}/records?asOf=2026-12-31`);
  const [hire] = ((await history.json()) as { items: { id: string }[] }).items;
  const hireBusiness = await w.employment('GET', `/businesses/${hire!.id}`);
  const patched = await w.employment('PATCH', `/records/${hire!.id}`, {
    ifMatch: ((await hireBusiness.json()) as { revision: number }).revision,
    body: { fields: { workYearCompanyBefore: 1.95 } },
  });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const current = await w.employment('GET', `/employees/${employee.id}`);
  const retirement = await w.employment('POST', `/retirements/employees/${employee.id}`, {
    ifMatch: ((await current.json()) as { revision: number }).revision,
    body: { mode: 'direct', lastWorkDate: '2026-10-25' },
  });
  expect(retirement.status, await retirement.clone().text()).toBe(201);
  const retire = (await retirement.json()) as { id: string };
  const offer = await w.social({ personalEmail: loginEmailOf(employee.id), plannedEntryDate: '2026-10-27' });
  const linked = await w.request('POST', `/${offer.id}/link-employee`, {
    ifMatch: offer.revision,
    body: { employeeId: employee.id },
  });
  expect(linked.status, await linked.clone().text()).toBe(200);
  const accepted = await w.accepted((await linked.json()) as SyncOffer);
  expect(await exitActivator(w.db, w)(retire.id, '2026-10-26')).toMatchObject({ outcome: 'effective' });
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-26T04:00:00Z') });
  const synced = await api.request('POST', `/api/tenant/offers/${accepted.id}/sync`, {
    tenant: w.tenant.id,
    user: w.user.id,
    ifMatch: (await w.read(accepted.id)).revision,
    body: {},
  });
  expect(synced.status, await synced.clone().text()).toBe(200);
  const result = (await synced.json()) as SyncOffer;
  expect(result).toMatchObject({ syncStatus: 'success', syncTarget: 'pending_entry' });
  if (on) await putSetting(w.db, { user: w.user.id, tenant: w.tenant.id }, RETIRE_REHIRE_SETTING, true);
  const done = await w.employment('POST', `/pending-entries/${result.pendingEntryBusinessId}/complete`, {
    ifMatch: await (async () =>
      (
        (await (await w.employment('GET', `/businesses/${result.pendingEntryBusinessId}`)).json()) as {
          revision: number;
        }
      ).revision)(),
    body: { probation: false },
  });
  expect(done.status, await done.clone().text()).toBe(200);
  const saved = await w.record(result.pendingEntryBusinessId!);
  expect(saved.fields.workYearCompanyBefore).toBe(on ? handTenure('2026-10-17', '2026-10-25', 1.95) : 0);
  if (on) expect(saved.fields.workYearCompanyBefore).toBe(1.9);
});
