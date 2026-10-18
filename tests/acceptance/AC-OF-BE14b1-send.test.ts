/**
 * BE-14b1：Offer 发送 / 重发（OF-R5）、发送前须审批（AC-OF-01 发送被拒）、超编弱控二次确认（AC-OF-13，OF-R10）。
 * 邮件首版只记一行发送记录（状态 pending，不显示投递状态）；答复链接与候选人答复页归 F-183，本单不生成令牌。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerRealWorld, offerWorld } from './AC-OF-BE14a-support.js';
import { requireApproval, rowsOf, sendRecords, send, setEstablishment } from './AC-OF-BE14b1-support.js';

const testDb = useTestDb();
const accept = { target: 'accepted', acceptTime: '2026-10-16' };

describe('AC-OF-01 发送（OF-R5）', () => {
  it('待发社招发送：进已发、记发送人与时间、写一行 pending 发送记录并带审计', async () => {
    const w = await offerWorld(testDb().db, 'send-ok');
    const offer = await w.social();
    const response = await send(w, offer, { cc: ['cc@example.com'], bcc: ['bcc@example.com'] });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'sent', sentBy: w.user.id, revision: offer.revision + 1 });
    expect(body.sentAt).toBeTruthy();
    expect(body.sendRecord).toMatchObject({ kind: 'send', status: 'pending' });
    expect(await sendRecords(w, offer.id)).toEqual([
      {
        kind: 'send',
        status: 'pending',
        recipient: offer.personalEmail,
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
      },
    ]);
    expect((await w.get(offer.id)).status).toBe('sent');
  });

  it('实习 Offer 同样能发送；已发的 Offer 重发记 resend，仍是已发，两行记录', async () => {
    const w = await offerWorld(testDb().db, 'send-resend');
    const offer = await w.intern();
    const first = await send(w, offer);
    expect(first.status, await first.clone().text()).toBe(200);
    const sent = await w.get(offer.id);
    const again = await send(w, sent);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'sent', sendRecord: { kind: 'resend' } });
    expect((await sendRecords(w, offer.id)).map((record) => record.kind)).toEqual(['send', 'resend']);
  });

  it('其他状态不能发送：已接受 / 已拒绝 / 失效 → 409 OFFER_NOT_PENDING，没有发送记录', async () => {
    const w = await offerWorld(testDb().db, 'send-state');
    const accepted = await w.social();
    const done = await w.moved(accepted, accept);
    const rejected = await w.social();
    await w.force(rejected.id, 'status', 'sent');
    const refused = await w.moved(await w.get(rejected.id), {
      target: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
    });
    const invalid = await w.social();
    await w.invalidated(invalid.id);
    for (const offer of [done, refused, await w.get(invalid.id)]) {
      const response = await send(w, offer);
      expect(response.status, offer.status).toBe(409);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_NOT_PENDING' });
      expect(await sendRecords(w, offer.id)).toEqual([]);
    }
  });

  it('请求体校验：抄送须为邮箱、不允许多余字段 → 400；revision 不符 → 409，都不发送', async () => {
    const w = await offerWorld(testDb().db, 'send-input');
    const offer = await w.social();
    expect((await send(w, offer, { cc: ['not-an-email'] })).status).toBe(400);
    expect((await send(w, offer, { extra: 1 })).status).toBe(400);
    expect((await send(w, { id: offer.id, revision: offer.revision + 5 })).status).toBe(409);
    expect((await w.get(offer.id)).status).toBe('pending');
    expect(await sendRecords(w, offer.id)).toEqual([]);
  });

  it('同键重放返回同一结果，只写一行发送记录', async () => {
    const w = await offerWorld(testDb().db, 'send-replay');
    const offer = await w.social();
    const key = randomUUID();
    const first = await send(w, offer, {}, { idempotencyKey: key });
    const replay = await send(w, offer, {}, { idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await sendRecords(w, offer.id)).toHaveLength(1);
  });
});

describe('AC-OF-01 发送前须审批：发送被拒', () => {
  it('社招要求审批：未审批发送 409 OFFER_APPROVAL_REQUIRED，Offer 不变；审批通过后可发送', async () => {
    const w = await offerWorld(testDb().db, 'send-approval');
    expect((await requireApproval(w)).status).toBe(200);
    const offer = await w.social();
    const denied = await send(w, offer);
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_APPROVAL_REQUIRED' });
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: offer.revision });
    expect(await sendRecords(w, offer.id)).toEqual([]);
    await w.force(offer.id, 'approval_status', 'approving');
    const approving = await send(w, await w.get(offer.id));
    expect((await errorOf(approving)).details).toMatchObject({ reason: 'OFFER_APPROVAL_IN_PROGRESS' });
    await w.force(offer.id, 'approval_status', 'approved');
    const allowed = await send(w, await w.get(offer.id));
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  it('实习不受社招开关影响，无需审批即可发送', async () => {
    const w = await offerWorld(testDb().db, 'send-approval-intern');
    expect((await requireApproval(w)).status).toBe(200);
    const intern = await w.intern();
    expect((await send(w, intern)).status).toBe(200);
  });
});

describe('AC-OF-13 超编弱控：发送和管理员转已接受要二次确认（OF-R10）', () => {
  it('弱控超编：发送先 409 CONFIRMATION_REQUIRED（不发送），带 confirmed 重提后发送成功', async () => {
    const w = await offerWorld(testDb().db, 'quota-send');
    await setEstablishment(w, false, 0);
    const offer = await w.social();
    const first = await send(w, offer);
    expect(first.status).toBe(409);
    expect((await errorOf(first)).details).toMatchObject({
      reason: 'CONFIRMATION_REQUIRED',
      level: 'warning',
      warnings: [{ departmentId: w.department.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
    });
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: offer.revision });
    expect(await sendRecords(w, offer.id)).toEqual([]);
    const confirmed = await send(w, offer, { confirmed: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(await sendRecords(w, offer.id)).toHaveLength(1);
  });

  it('管理员转已接受（行主按钮与顶部工具栏两个入口）：超编先要确认，确认后成功', async () => {
    const w = await offerWorld(testDb().db, 'quota-accept');
    await setEstablishment(w, false, 0);
    const row = await w.social();
    const toolbar = await w.social();
    for (const [offer, via] of [[row, 'row'] as const, [toolbar, 'toolbar'] as const]) {
      const first = await w.transfer(offer, accept, via);
      expect(first.status).toBe(409);
      expect((await errorOf(first)).details).toMatchObject({ reason: 'CONFIRMATION_REQUIRED', level: 'warning' });
      expect((await w.get(offer.id)).status).toBe('pending');
      const confirmed = await w.transfer(offer, { ...accept, confirmed: true }, via);
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    }
  });

  it('未超编不需要确认；管理员转已拒绝不判编制', async () => {
    const w = await offerWorld(testDb().db, 'quota-ok');
    await setEstablishment(w, false, 5);
    const offer = await w.social();
    expect((await w.transfer(offer, accept)).status).toBe(200);
    const other = await w.social();
    await setEstablishment(w, false, 0);
    const refused = await w.transfer(other, {
      target: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
    });
    expect(refused.status, await refused.clone().text()).toBe(200);
  });

  it('强控超编：发送与管理员转已接受同样先要确认（强控的拒绝落在同步待入职，归 BE-14b2）', async () => {
    const w = await offerWorld(testDb().db, 'quota-strict');
    await setEstablishment(w, true, 0);
    const offer = await w.social();
    const first = await send(w, offer);
    expect(first.status).toBe(409);
    expect((await errorOf(first)).details).toMatchObject({ reason: 'CONFIRMATION_REQUIRED', level: 'strict' });
    expect((await send(w, offer, { confirmed: true })).status).toBe(200);
    const other = await w.social();
    expect((await w.transfer(other, accept)).status).toBe(409);
    expect((await w.transfer(other, { ...accept, confirmed: true })).status).toBe(200);
  });
});

describe('发送的权限与行操作', () => {
  it('发送按对象编辑开关：无编辑开关 403，不发送；有权时待发行出现 send、已发行主按钮 resend', async () => {
    const w = await offerRealWorld(testDb().db, 'send-access');
    const offer = await w.social();
    const detail = async (id: string) =>
      ((await (await w.real('GET', `/${id}`)).json()) as { rowActions: { primary: string[]; menu: string[] } })
        .rowActions;
    expect((await detail(offer.id)).menu).toContain('send');
    const sent = await w.real('POST', `/${offer.id}/send`, { ifMatch: offer.revision, body: {} });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await detail(offer.id)).primary).toEqual(['resend']);
    await w.dropUpdate();
    const denied = await w.real('POST', `/${offer.id}/send`, { ifMatch: offer.revision + 1, body: {} });
    expect(denied.status).toBe(403);
    expect((await detail(offer.id)).primary).toEqual([]);
  });

  it('范围外的 Offer 返回 404', async () => {
    const w = await offerRealWorld(testDb().db, 'send-scope');
    const org = await w.seeder.request('POST', '/api/tenant/org/organizations', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: { name: '范围外录用部门', parents: { admin: { parentId: w.tenant.id } }, establishedOn: '2026-01-01' },
    });
    const outside = await w.intern({ departmentId: ((await org.json()) as { id: string }).id });
    const response = await w.real('POST', `/${outside.id}/send`, { ifMatch: outside.revision, body: {} });
    expect(response.status).toBe(404);
  });
});

describe('P2-03 发送过又退回待发的 Offer 仍可删除', () => {
  it('新建 → 发送 → 转回待发 → 详情给 delete → 删除成功；发送记录随之删除，删除审计的快照保留发送历史', async () => {
    const w = await offerWorld(testDb().db, 'delete-sent');
    const offer = await w.social();
    expect((await send(w, offer, { cc: ['cc@example.com'] })).status).toBe(200);
    const back = await w.moved(await w.get(offer.id), { target: 'pending' });
    const detail = await w.request('GET', `/${offer.id}`);
    expect(((await detail.json()) as { rowActions: { menu: string[] } }).rowActions.menu).toContain('delete');
    const deleted = await w.request('DELETE', `/${offer.id}`, { ifMatch: back.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await w.request('GET', `/${offer.id}`)).status).toBe(404);
    expect(await sendRecords(w, offer.id)).toEqual([]);
    const audits = rowsOf<{ action: string; before: { sendRecords?: { kind: string; cc: string[] }[] } | null }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT action, before FROM audit_events WHERE tenant_id = ${w.tenant.id}
          AND object_id = ${offer.id} ORDER BY occurred_at, id`),
      ),
    );
    expect(audits.map((audit) => audit.action)).toContain('offer.delete');
    const snapshot = audits.find((audit) => audit.action === 'offer.delete')!.before;
    expect(snapshot?.sendRecords).toMatchObject([{ kind: 'send', cc: ['cc@example.com'] }]);
  });
});
