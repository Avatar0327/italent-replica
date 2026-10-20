/**
 * F-234BE：Offer“查看 Offer 邮件”读口 GET /offers/:id/mail（原站新标签详情页 OfferEmailDetailView，F234A B5 / B6）。
 * 数据取该 Offer 最近一条发送记录（收件人 / 抄送 / 密送）与当前 Offer 行（姓名、录用部门等）；正文由内置固定模板渲染为
 * 纯文本段落，不返回 HTML；不展示发送时间 / 发送人 / 历史 / 投递状态。读权限同查看 Offer，字段按各自查看字段权裁剪。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerRealWorld, offerWorld, type OfferWorld } from './AC-OF-BE14a-support.js';
import { rowsOf, send } from './AC-OF-BE14b1-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

const departmentName = async (w: OfferWorld, orgId: string) =>
  rowsOf<{ name: string }>(
    await withTenant(w.db, w.tenant.id, (tx) => tx.execute(sql`SELECT name FROM org_versions WHERE org_id = ${orgId}`)),
  )[0]!.name;

const mailOf = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    offerId: string;
    name: string;
    recipient: string | null;
    subject: string;
    notice: { title: string; paragraphs: string[] };
    attachments: unknown[];
    cc: string[] | null;
    bcc: string[] | null;
  };
};

describe('F-234BE 查看 Offer 邮件', () => {
  it('已发：形状固定，收件人 / 抄送 / 密送取发送记录，正文含候选人姓名与录用部门、无 HTML、无发送时间等', async () => {
    const w = await offerWorld(testDb().db, 'mail-sent');
    const offer = await w.social({ name: '邮件候选人', workPlace: '上海' });
    expect((await send(w, offer, { cc: ['cc@example.com'], bcc: ['bcc@example.com'] })).status).toBe(200);
    const mail = await mailOf(await w.request('GET', `/${offer.id}/mail`));
    expect(Object.keys(mail).sort()).toEqual(
      ['attachments', 'bcc', 'cc', 'name', 'notice', 'offerId', 'recipient', 'subject'].sort(),
    );
    expect(mail).toMatchObject({
      offerId: offer.id,
      name: '邮件候选人',
      recipient: offer.personalEmail,
      subject: '录用通知',
      attachments: [],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
    });
    expect(mail.notice.title).toBe('录用通知书');
    const text = mail.notice.paragraphs.join('\n');
    expect(mail.notice.paragraphs.length).toBeGreaterThan(1);
    expect(text).toContain('邮件候选人');
    expect(text).toContain(await departmentName(w, w.department.id));
    expect(text).toContain('上海');
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).not.toContain('http');
  });

  it('已入职 / 已拒绝 / 失效（已发过）同样可查看', async () => {
    const w = await offerWorld(testDb().db, 'mail-states');
    for (const status of ['onboarded', 'rejected', 'invalid']) {
      const offer = await w.social();
      expect((await send(w, offer)).status).toBe(200);
      await w.force(offer.id, 'status', status);
      const mail = await mailOf(await w.request('GET', `/${offer.id}/mail`));
      expect(mail, status).toMatchObject({ offerId: offer.id, recipient: offer.personalEmail, subject: '录用通知' });
    }
  });

  it('重发两次后只返回最近一次的收件人 / 抄送 / 密送', async () => {
    const w = await offerWorld(testDb().db, 'mail-resend');
    const offer = await w.social();
    expect((await send(w, offer, { cc: ['first-cc@example.com'], bcc: ['first-bcc@example.com'] })).status).toBe(200);
    const second = await send(w, await w.get(offer.id), { cc: ['second-cc@example.com'] });
    expect(second.status, await second.clone().text()).toBe(200);
    const third = await send(w, await w.get(offer.id), { bcc: ['third-bcc@example.com'] });
    expect(third.status, await third.clone().text()).toBe(200);
    expect(await mailOf(await w.request('GET', `/${offer.id}/mail`))).toMatchObject({
      cc: [],
      bcc: ['third-bcc@example.com'],
    });
  });

  it('没有发送记录 → 404 OFFER_MAIL_NOT_SENT；不存在 404；:id 非 UUID 400', async () => {
    const w = await offerWorld(testDb().db, 'mail-missing');
    const pending = await w.social();
    const unsent = await w.request('GET', `/${pending.id}/mail`);
    expect(unsent.status).toBe(404);
    expect((await errorOf(unsent)).details).toMatchObject({ reason: 'OFFER_MAIL_NOT_SENT' });
    const missing = await w.request('GET', `/${randomUUID()}/mail`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).details?.reason).toBeUndefined();
    expect((await w.request('GET', '/not-a-uuid/mail')).status).toBe(400);
  });

  it('范围外 HR 看不到 → 404（与不存在同形，不暴露是否发送过）', async () => {
    const w = await offerRealWorld(testDb().db, 'mail-scope');
    const created = await w.seeder.request('POST', '/api/tenant/org/organizations', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: {
        name: `范围外${uniqueSuffix()}`,
        parents: { admin: { parentId: w.tenant.id } },
        establishedOn: '2026-01-01',
      },
    });
    const outside = (await created.json()) as { id: string };
    const hidden = await w.social({ departmentId: outside.id });
    expect((await send(w, hidden)).status).toBe(200);
    const visible = await w.social();
    expect((await send(w, visible)).status).toBe(200);
    const refused = await w.real('GET', `/${hidden.id}/mail`);
    expect(refused.status, await refused.clone().text()).toBe(404);
    expect((await errorOf(refused)).details?.reason).toBeUndefined();
    expect((await w.real('GET', `/${visible.id}/mail`)).status).toBe(200);
  });

  it('没有 personalEmail 查看字段权：recipient / cc / bcc 为 null；姓名与录用部门无查看权则以“--”代替', async () => {
    const w = await offerRealWorld(testDb().db, 'mail-fields');
    const offer = await w.social({ name: '字段权候选人' });
    expect((await send(w, offer, { cc: ['cc@example.com'], bcc: ['bcc@example.com'] })).status).toBe(200);
    await w.permitObject(MODULE_OBJECTS.offer, ['personalEmail']);
    const noEmail = await mailOf(await w.real('GET', `/${offer.id}/mail`));
    expect(noEmail).toMatchObject({ name: '字段权候选人', recipient: null, cc: null, bcc: null });
    expect(noEmail.notice.paragraphs.join('\n')).toContain('字段权候选人');
    await w.permitObject(MODULE_OBJECTS.offer, ['name', 'departmentId']);
    const noName = await mailOf(await w.real('GET', `/${offer.id}/mail`));
    expect(noName.name).toBe('--');
    expect(noName.recipient).toBe(offer.personalEmail);
    const text = noName.notice.paragraphs.join('\n');
    expect(text).not.toContain('字段权候选人');
    expect(text).not.toContain(await departmentName(w, w.department.id));
    expect(text).toContain('--');
  });
});
