/** F-478 S6：R-2“同时返聘”自动生成的返聘业务，落地时按开关累计（设计 §7.2）。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rehireWorld } from './AC-RT-rehire-support.js';
import { handTenure, putSetting, RETIRE_REHIRE_SETTING, seedSettings } from './AC-EMP-F478-seniority-support.js';

const database = useTestDb();

it.each([true, false])('AC-EMP-F478-22：同时返聘经调度落地，开关 %s；撤销（删除）返聘从快照恢复', async (on) => {
  await seedSettings(database().db);
  const x = await rehireWorld(database().db, `f478-s6-r2-${on}`, '2026-10-06');
  const who = { user: x.session.user.id, tenant: x.session.tenant.id };
  if (on) await putSetting(database().db, who, RETIRE_REHIRE_SETTING, true);
  // 入职段校正值 2.29：入职日取时间轴第一条，最后工作日 2026-10-15（E = 10-16，返聘日 R = 10-17）
  const [hireRow] = await x.timeline();
  const hire = await x.business(hireRow!.record_id);
  const patched = await x.session.request('PATCH', `/records/${hireRow!.record_id}`, {
    ifMatch: hire.revision,
    body: { fields: { workYearCompanyBefore: 2.29 } },
  });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const retire = await x.createdRehire(
    x.rehireBody('2026-10-15', 'direct', x.rehirePlan({ fields: { workYearCompanyBefore: 0.5 } })),
  );
  expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [retire.id], failed: [] });
  const rehireId = (await x.extension(retire.id))!.rehire_business_id!;
  const expected = handTenure(hireRow!.start_date, '2026-10-15', 2.29);
  const rehired = await x.business(rehireId);
  expect(rehired.record?.fields.workYearCompanyBefore).toBe(on ? expected : 0.5);
  if (on) expect(expected).toBe(2.4);
  expect((await x.audits(rehireId, 'employment.retire_rehire.seniority')).length).toBe(on ? 1 : 0);
  const blocked = await x.session.request('DELETE', `/businesses/${retire.id}`, {
    ifMatch: (await x.business(retire.id)).revision,
  });
  expect(blocked.status).toBe(409);
  expect(JSON.stringify(await blocked.json())).toContain('RETIREMENT_HAS_REHIRE');
  const removed = await x.session.request('DELETE', `/businesses/${rehireId}`, { ifMatch: rehired.revision, body: {} });
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect((await x.audits(rehireId, 'employment.retire_rehire.seniority.restore')).length).toBe(on ? 1 : 0);
});
