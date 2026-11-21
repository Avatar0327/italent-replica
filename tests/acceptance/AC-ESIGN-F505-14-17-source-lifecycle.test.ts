import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { overrideSetting } from './AC-OF-BE14b1-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { ESIGN, lifecycleWorld, ok, REJECT, taskFixture } from './AC-ESIGN-F505-s3-support.js';

const testDb = useTestDb();

it('AC-14/16 Offer 转拒绝：撤销 Offer 与入站取消的待入职各自任务', async () => {
  const w = await lifecycleWorld(testDb().db, 'reject');
  const { source, entry, offerTask, entryTask } = await w.pair();
  expect(await w.moved(source, REJECT)).toMatchObject({ status: 'rejected' });
  expect((await w.entries('cancelled')).map(({ id }) => id)).toContain(entry.id);
  await w.revoked(offerTask, 'source_cancelled');
  await w.revoked(entryTask, 'source_cancelled');
  await w.moved(await w.readOffer(source.id), { target: 'accepted', acceptTime: '2026-10-17' });
  await w.revoked(offerTask, 'source_cancelled');
});

it('AC-14/16 Offer 失效：Offer 撤销，入站删除旧待入职任务，同人来源相互独立', async () => {
  const w = await lifecycleWorld(testDb().db, 'invalidate');
  const { source, entry, offerTask, entryTask } = await w.pair();
  await ok(await w.invalidate(source, { reasonCode: 'candidate_gave_up' }));
  expect(await w.readOffer(source.id)).toMatchObject({ status: 'invalid' });
  expect((await w.entries()).map(({ id }) => id)).not.toContain(entry.id);
  await w.revoked(offerTask, 'source_cancelled');
  await w.revoked(entryTask, 'business_deleted');
});

it('AC-14 同值保存保持签署，Offer 实际正文变更使旧文件撤销', async () => {
  const w = await lifecycleWorld(testDb().db, 'body');
  const { source, offerTask, entryTask } = await w.pair();
  const same = await ok<OfferView>(await w.editOffer(source, { name: source.name }));
  expect(await w.read(offerTask.id)).toEqual(offerTask);
  await ok(await w.editOffer(same, { name: 'ZZ_F505_改名候选人' }));
  await w.revoked(offerTask, 'source_changed');
  expect(await w.read(entryTask.id)).toEqual(entryTask);
});

it.each([true, false])('AC-14/16 改必审字段触发真实重新审批，开关 %s', async (reapprovalAllowed) => {
  const { db } = testDb();
  const w = await offerApprovalWorld(db, 'ZZ_F505_reapproval');
  const settings = {
    'offer.send_requires_approval': { social: true, campus: false, intern: false },
    'offer.review_fields': { social: ['salaryAfterRegular'], campus: [], intern: [] },
    'offer.linkage': { entryCancelRejects: true, reapprovalAllowed },
    'offer.sync_timing': { enabled: false, mode: 'on_accept', days: 30, internConversion: true },
  };
  for (const [key, value] of Object.entries(settings)) {
    await ok(await w.request(w.hr.id, 'PUT', `/api/tenant/settings/${key}`, { ifMatch: 0, body: { value } }));
  }
  const path = '/api/tenant/offers';
  const user = w.applicant.userId;
  const created = await w.social(w.applicant);
  const edit = async (revision: number, salaryAfterRegular: number) =>
    ok<OfferView & { replacedOfferId?: string }>(
      await w.request(user, 'PUT', `${path}/${created.id}`, { ifMatch: revision, body: { salaryAfterRegular } }),
    );
  const salaried = await edit(created.revision, 10000);
  await ok(await w.submitRaw(salaried));
  await w.decide(await w.instance(salaried.id), w.head, 'approve');
  const approved = await w.get(created.id);
  expect(approved.approvalStatus).toBe('approved');
  await ok(await w.request(user, 'POST', `${path}/${approved.id}/send`, { ifMatch: approved.revision, body: {} }));
  const accepted = await ok<OfferView>(
    await w.request(user, 'POST', `${path}/${approved.id}/transfer`, {
      ifMatch: (await w.get(approved.id)).revision,
      body: { target: 'accepted', acceptTime: '2026-10-17' },
    }),
  );
  const fixture = taskFixture(db, w.tenant.id, user);
  const task = await fixture.seed({ offerId: accepted.id }, w.manager.employeeId, accepted.revision);
  const changed = await edit(accepted.revision, 12000);
  expect(changed).toMatchObject({ status: 'pending', approvalStatus: 'approving' });
  if (reapprovalAllowed) expect(changed.id).toBe(accepted.id);
  else {
    expect(changed.replacedOfferId).toBe(accepted.id);
    expect(await w.get(accepted.id)).toMatchObject({ status: 'invalid' });
    expect(await fixture.query(sql`SELECT 1 FROM esign_tasks WHERE offer_id=${changed.id}::uuid`)).toEqual([]);
  }
  expect((await w.instanceOfAll(changed.id, user)).map(({ status }) => status).sort()).toEqual(
    reapprovalAllowed ? ['approved', 'running'] : ['running'],
  );
  await fixture.revoked(task, 'source_cancelled');
});

it('AC-15 签完后退待发再物理删除，保留锚点、历史文件和本人下载', async () => {
  const w = await lifecycleWorld(testDb().db, 'delete');
  const { source, offerTask } = await w.pair();
  await ok(await w.sign(offerTask, offerTask.employeeSignerUserId!));
  await ok(await w.sign(await w.read(offerTask.id), w.user.id));
  const completed = await w.read(offerTask.id);
  expect(completed.status).toBe('completed');
  const fileRows = await w.files(completed.id);
  expect(fileRows).toHaveLength(1);
  const draft = await w.moved(await w.moved(source, REJECT), { target: 'pending' });
  await ok(await w.deleteOffer(draft));
  expect((await w.request('GET', `/${draft.id}`)).status).toBe(404);
  const [anchor] = await w.query(sql`SELECT deleted_at FROM esign_offer_sources WHERE offer_id=${draft.id}::uuid`);
  expect(anchor).toMatchObject({ deleted_at: expect.anything() });
  expect(await w.read(completed.id)).toEqual(completed);
  expect(await w.files(completed.id)).toEqual(fileRows);
  const own = await w.seeder.request('GET', `${ESIGN}/mine/${completed.id}/files`, {
    tenant: w.tenant.id,
    user: completed.employeeSignerUserId!,
  });
  expect(own.status).toBe(200);
  expect(own.headers.get('content-type')).toContain('application/pdf');
});

it('AC-16 取消联动开时撤销两来源，改期恢复只恢复业务状态', async () => {
  const w = await lifecycleWorld(testDb().db, 'restore');
  const { source, entry, offerTask, entryTask } = await w.pair();
  await ok(await w.cancelEntry(entry.id));
  expect(await w.readOffer(source.id)).toMatchObject({ status: 'rejected' });
  const replacement = await ok<{ id: string }>(
    await w.entryAction(entry.id, 'postpone', { effectiveDate: '2026-11-20' }),
  );
  expect(replacement.id).not.toBe(entry.id);
  expect(await w.readOffer(source.id)).toMatchObject({ status: 'accepted', pendingEntryBusinessId: replacement.id });
  expect(await w.query(sql`SELECT 1 FROM esign_tasks WHERE business_id=${replacement.id}::uuid`)).toEqual([]);
  await w.revoked(offerTask, 'source_cancelled');
  await w.revoked(entryTask, 'source_cancelled');
});

it('AC-16 取消联动关时只撤销入职任务', async () => {
  const w = await lifecycleWorld(testDb().db, 'cancel-only');
  await overrideSetting(w, 'offer.linkage', { entryCancelRejects: false, reapprovalAllowed: true });
  const { source, entry, offerTask, entryTask } = await w.pair();
  await ok(await w.cancelEntry(entry.id));
  expect(await w.readOffer(source.id)).toMatchObject({ status: 'accepted' });
  await w.revoked(entryTask, 'source_cancelled');
  expect(await w.read(offerTask.id)).toEqual(offerTask);
});

it.each(['改期', '编辑换日期', '编辑雇佣关系', '直接删除'])('AC-16/17 %s 撤销旧 ID，无历史嫁接', async (action) => {
  const w = await lifecycleWorld(testDb().db, 'replace');
  const { entry, offerTask, entryTask } = await w.pair();
  const response =
    action === '改期'
      ? await w.entryAction(entry.id, 'postpone', { effectiveDate: '2026-11-20' })
      : action === '直接删除'
        ? await w.employment('DELETE', `/pending-entries/${entry.id}`, { ifMatch: await w.businessRevision(entry.id) })
        : await w.editEntry(entry.id, {
            effectiveDate: action === '编辑换日期' ? '2026-11-20' : entry.effectiveDate,
            probation: true,
            ...(action === '编辑雇佣关系' ? { employType: 'intern' } : {}),
          });
  const changed = await ok<{ id: string }>(response);
  if (action !== '直接删除') {
    expect(changed.id).not.toBe(entry.id);
    expect(await w.query(sql`SELECT 1 FROM esign_tasks WHERE business_id=${changed.id}::uuid`)).toEqual([]);
  }
  expect((await w.entries()).map(({ id }) => id)).not.toContain(entry.id);
  await w.revoked(entryTask, 'business_deleted');
  expect(await w.read(offerTask.id)).toEqual(offerTask);
});

it('AC-17 同 ID 试用期 no-op 保留，实际改动撤销', async () => {
  const w = await lifecycleWorld(testDb().db, 'probation');
  const { entry, offerTask, entryTask } = await w.pair();
  await ok(await w.editEntry(entry.id, { effectiveDate: entry.effectiveDate, probation: true }));
  expect(await w.read(entryTask.id)).toEqual(entryTask);
  const changed = await ok<{ id: string }>(
    await w.editEntry(entry.id, { effectiveDate: entry.effectiveDate, probation: false }),
  );
  expect(changed.id).toBe(entry.id);
  await w.revoked(entryTask, 'source_changed');
  expect(await w.read(offerTask.id)).toEqual(offerTask);
});

it('AC-17 Offer 编辑并同步仅改待入职合同，旧记录撤销及换 ID，no-op 不撤销', async () => {
  const w = await lifecycleWorld(testDb().db, 'contract');
  const { source, entry, offerTask, entryTask } = await w.pair();
  const same = await ok<OfferView>(await w.editOffer(source, { syncPendingEntry: true }));
  expect(await w.read(entryTask.id)).toEqual(entryTask);
  expect(await w.read(offerTask.id)).toEqual(offerTask);
  const changed = await ok<OfferView>(
    await w.editOffer(same, { contractEndDate: '2029-06-30', syncPendingEntry: true }),
  );
  expect(changed.pendingEntryBusinessId).not.toBe(entry.id);
  expect(await w.entryOf(await w.readOffer(source.id))).toMatchObject({ contractEndDate: '2029-06-30' });
  await w.revoked(entryTask, 'business_deleted');
  await w.revoked(offerTask, 'source_changed');
});

it('AC-14 关联同一人后立即同步只写元数据，旧任务保留', async () => {
  const w = await lifecycleWorld(testDb().db, 'same-person');
  await w.timing({ enabled: false });
  const intern = await w.internEmployee('ZZ_F505_在职实习生');
  const draft = await w.social({ name: 'ZZ_F505_实习转正候选人', personalEmail: loginEmailOf(intern.id) });
  await ok(
    await w.request('POST', `/${draft.id}/link-employee`, {
      ifMatch: draft.revision,
      body: { employeeId: intern.id },
    }),
  );
  const accepted = await w.accepted(await w.get(draft.id));
  const task = await w.seed({ offerId: accepted.id }, intern.id, accepted.revision);
  const synced = await w.synced(accepted);
  expect(synced).toMatchObject({ syncStatus: 'success', syncTarget: 'intern_regularization' });
  expect(await w.record(synced.pendingEntryBusinessId!)).toMatchObject({ employeeId: intern.id });
  expect(await w.read(task.id)).toEqual(task);
  expect(await w.notices(task.id)).toEqual([]);
  const unchanged = await w.synced(synced);
  expect(unchanged.revision).toBe(synced.revision);
});

it('AC-17 办理入职与 Offer 变已入职都保留在途任务，原本人仍可签署', async () => {
  const w = await lifecycleWorld(testDb().db, 'complete');
  const { source, entry, offerTask, entryTask } = await w.pair({ contractEndDate: null });
  await ok(
    await w.employment('POST', `/pending-entries/${entry.id}/complete`, {
      ifMatch: await w.businessRevision(entry.id),
      body: { probation: false },
    }),
  );
  expect(await w.readOffer(source.id)).toMatchObject({ status: 'onboarded', pendingEntryBusinessId: entry.id });
  expect(await w.read(offerTask.id)).toEqual(offerTask);
  expect(await w.read(entryTask.id)).toEqual(entryTask);
  await ok(await w.sign(entryTask, entryTask.employeeSignerUserId!));
  expect(await w.read(entryTask.id)).toMatchObject({ status: 'signing', currentNode: 'enterprise' });
});
