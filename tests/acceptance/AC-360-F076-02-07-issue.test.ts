/**
 * AC-360-F076-02～07（F-076 PR-1，设计 §2.5、§9）：启用 / 重发 / 确认邀请写入口的凭据分支与开关。
 * 命令事务内不做 KDF；开关关闭或确认邀请时行为同以前，只是令牌改为加密保存；不经登录，直接断言存储。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { kdfCallCount, resetKdfCallCount } from '../../apps/api/src/modules/survey360/credentials.js';
import { key, sceneB } from './AC-360-B-support.js';
import {
  invitations,
  linkRows,
  portalCredentials,
  resetCredentialConfig,
  rowsOf,
  securityEvents,
} from './AC-360-F076-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());

const ANSWER = 'survey360.answer_invitation';

describe('AC-360-F076-02 开关打开：启用活动只把链接标为待发放', () => {
  it('作答链接 pending、摘要为空；邀请 awaiting_credential，sealed 解封后只有令牌；命令内 KDF 0 次', async () => {
    portalCredentials(true);
    resetKdfCallCount();
    const s = await sceneB(testDb().db, 'f076-02');
    const { w } = s;

    const links = await linkRows(w, s.activity.id);
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link).toMatchObject({
        credential_state: 'pending',
        serial_lookup: null,
        password_hash: null,
        credential_key_version: null,
        credential_key_versions: [],
        revoked: false,
      });
    }

    const mails = await invitations(w);
    expect(mails).toHaveLength(5);
    for (const mail of mails) {
      const link = links.find((l) => l.person_id === mail.payload['personId'])!;
      expect(mail.state).toBe('awaiting_credential');
      expect(mail.payload['linkId']).toBe(link.id);
      expect(mail.payload).not.toHaveProperty('token');
      expect(mail.payload).toHaveProperty('sealed');
      expect(Object.keys(mail.secrets)).toEqual(['token']);
      expect(typeof mail.secrets.token).toBe('string');
    }
    expect(kdfCallCount()).toBe(0);

    // 启用命令的审计只记人数（设计 §2.6），不记明文与摘要
    const [audit] = rowsOf<{ after: Record<string, unknown> }>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT after FROM audit_events WHERE action = 'survey360.activity.enable'`),
      ),
    );
    expect(audit!.after['credentialPending']).toBe(5);
  });

  it('进程控制里的邮件状态把 awaiting_credential 归入“待发送”（pending）', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-02b');
    const view = await s.w.ok<{ items: { personId: string; emailState: string | null }[] }>(
      s.w.request('GET', `${s.path}/progress`),
    );
    expect(view.items.map((i) => i.emailState)).toEqual(Array(5).fill('pending'));
  });
});

describe('AC-360-F076-04 已有链接不重复发放', () => {
  it('启用中给已有链接的评价者再加关系、重复启用：不新建链接行与凭据', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-04');
    const { w } = s;
    const before = await linkRows(w, s.activity.id);
    const mailsBefore = await invitations(w);

    // 同一评价者 P1 再被加到另一个评价对象
    const another = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    await w.appraiser(s.activity.id, another.id, s.person.P1.id, 'peer');
    // 活动已启用，重复启用被拒
    const current = await w.getActivity(s.activity.id);
    const again = await w.request('POST', `/activities/${s.activity.id}/enable`, { ifMatch: current.revision });
    expect(again.status).toBe(409);

    expect((await linkRows(w, s.activity.id)).map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(await invitations(w)).toHaveLength(mailsBefore.length);
    expect(await securityEvents(w, 'credential_reissued')).toEqual([]);
  });
});

describe('AC-360-F076-05 重发邮件邀请即换凭据', () => {
  it('发放前重发：旧行作废、新行 pending，旧新邀请的 linkId 分别指向旧行和新行，每人一条 credential_reissued', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-05');
    const { w } = s;
    const [old] = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.X.id);

    w.setNow('2026-10-01T05:00:00Z');
    await w.ok(
      w.request('POST', `${s.path}/invitations`, { idempotencyKey: key(), body: { personIds: [s.person.X.id] } }),
    );

    const links = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.X.id);
    expect(links.map((l) => [l.id, l.revoked, l.credential_state])).toEqual([
      [old!.id, true, 'pending'],
      [links[1]!.id, false, 'pending'],
    ]);
    const mails = (await invitations(w)).filter((m) => m.payload['personId'] === s.person.X.id);
    expect(mails.map((m) => m.payload['linkId'])).toEqual([old!.id, links[1]!.id]);
    expect(mails.map((m) => m.state)).toEqual(['awaiting_credential', 'awaiting_credential']);
    expect(mails[0]!.secrets.token).not.toBe(mails[1]!.secrets.token);

    const events = await securityEvents(w, 'credential_reissued');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      link_id: links[1]!.id,
      old_link_id: old!.id,
      activity_id: s.activity.id,
    });
  });
});

describe('AC-360-F076-06 确认邀请回归', () => {
  it('确认链接 credential_state = none，邀请直接 pending，sealed 只含令牌，确认链接照常可用', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-06');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/objects/${s.object.id}/confirmation`, { ifMatch: 0, body: {} }), 201);

    const confirmLinks = await linkRows(w, s.activity.id, 'confirm');
    expect(confirmLinks).toHaveLength(1);
    expect(confirmLinks[0]).toMatchObject({ credential_state: 'none', serial_lookup: null, password_hash: null });
    const [mail] = await invitations(w, 'survey360.confirm_invitation');
    expect(mail!.state).toBe('pending');
    expect(mail!.payload['linkId']).toBe(confirmLinks[0]!.id);
    expect(mail!.payload).not.toHaveProperty('token');
    expect(Object.keys(mail!.secrets)).toEqual(['token']);

    const confirm = w.link(await w.token(s.activity.id, s.person.M.id, 'survey360.confirm_invitation'));
    expect((await confirm('GET', '')).status).toBe(200);
  });
});

describe('AC-360-F076-07 开关关闭：行为同以前，令牌已加密', () => {
  it('作答链接 none、邀请直接 pending；维护任务不处理任何行', async () => {
    portalCredentials(false);
    const s = await sceneB(testDb().db, 'f076-07');
    const { w } = s;

    const links = await linkRows(w, s.activity.id);
    expect(links.every((l) => l.credential_state === 'none' && l.serial_lookup === null)).toBe(true);
    const mails = await invitations(w);
    expect(mails.map((m) => m.state)).toEqual(Array(5).fill('pending'));
    expect(mails.every((m) => !('token' in m.payload) && 'sealed' in m.payload)).toBe(true);

    const { runCredentialMaintenance } = await import('../../apps/api/src/modules/survey360/credential-maintenance.js');
    resetKdfCallCount();
    const report = await runCredentialMaintenance(w.db, { clock: () => new Date('2026-10-01T02:00:00Z') });
    expect(report.issued).toBe(0);
    expect(kdfCallCount()).toBe(0);
    expect((await linkRows(w, s.activity.id)).every((l) => l.credential_state === 'none')).toBe(true);
    // 开关关闭时重发不写 credential_reissued（没有凭据可换）
    w.setNow('2026-10-01T05:00:00Z');
    await w.ok(
      w.request('POST', `${s.path}/invitations`, { idempotencyKey: key(), body: { personIds: [s.person.X.id] } }),
    );
    expect(await securityEvents(w, 'credential_reissued')).toEqual([]);
  });
});
