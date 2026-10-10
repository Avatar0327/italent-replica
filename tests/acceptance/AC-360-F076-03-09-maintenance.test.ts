/**
 * AC-360-F076-03、08、09（F-076 PR-1，设计 §2.5、§9）：凭据维护任务——认领、生成与 KDF（事务外）、CAS 写回、
 * 崩溃重领、序列号冲突重试、明文不落库。
 */
import { randomUUID } from 'node:crypto';
import { survey360Links, survey360Outbox, survey360People, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import {
  kdfCallCount,
  kdfPeakConcurrency,
  resetKdfCallCount,
  serialLookup,
  verifyPassword,
} from '../../apps/api/src/modules/survey360/credentials.js';
import { sealJson } from '../../apps/api/src/modules/survey360/secret-box.js';
import { sceneB } from './AC-360-B-support.js';
import type { World360 } from './AC-360-support.js';
import {
  invitations,
  leakSurface,
  linkRows,
  portalCredentials,
  resetCredentialConfig,
  securityEvents,
} from './AC-360-F076-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());
const at = (iso: string) => () => new Date(iso);

describe('AC-360-F076-03 维护任务跑一轮', () => {
  it('行变为 issued 并按当前版本摘要；outbox 转 pending 且 sealed 含令牌 / 序列号 / 密码；每行一条 credential_issued', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-03');
    const { w } = s;
    const before = await invitations(w);
    const tokens = new Map(before.map((m) => [m.payload['linkId'] as string, m.secrets.token]));

    const report = await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:00:00Z') });
    expect(report.issued).toBe(5);

    const config = credentialConfig();
    const links = await linkRows(w, s.activity.id);
    const mails = await invitations(w);
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link).toMatchObject({
        credential_state: 'issued',
        credential_key_version: config.currentVersion,
        credential_key_versions: [config.currentVersion],
      });
      const mail = mails.find((m) => m.payload['linkId'] === link.id)!;
      expect(mail.state).toBe('pending');
      // 令牌保持不变（发放只追加序列号与密码）
      expect(mail.secrets.token).toBe(tokens.get(link.id));
      const { serial, password } = mail.secrets;
      expect(serial).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
      expect(password).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
      // 按设计 §2.3 复算，与库中摘要一致
      const key = config.credentialKeys.get(config.currentVersion)!;
      expect(serialLookup(key, serial!)).toBe(link.serial_lookup);
      expect(await verifyPassword(link.password_hash!, key, password!)).toBe(true);
      expect(await verifyPassword(link.password_hash!, key, 'WRONG234')).toBe(false);
      expect(link.password_hash).toMatch(/^scrypt\$\d+\$8\$1\$/);
    }
    const events = await securityEvents(w, 'credential_issued');
    expect(events.map((e) => e.link_id).sort()).toEqual(links.map((l) => l.id).sort());
    expect(events.every((e) => e.credential_key_version === config.currentVersion)).toBe(true);
    expect(events.every((e) => e.activity_id === s.activity.id)).toBe(true);

    // 再跑一轮没有可发放的行
    expect((await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:10:00Z') })).issued).toBe(0);
  });
});

describe('AC-360-F076-08 库中查不到明文', () => {
  it('审计、命令台账、outbox 除 sealed 外的字段、安全事件里没有序列号、密码、令牌明文，也没有摘要全文', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-08');
    const { w } = s;
    await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:00:00Z') });
    w.setNow('2026-10-01T05:00:00Z');
    await w.ok(
      w.request('POST', `${s.path}/invitations`, {
        idempotencyKey: randomUUID(),
        body: { personIds: [s.person.X.id] },
      }),
    );
    await runCredentialMaintenance(w.db, { clock: at('2026-10-01T06:00:00Z') });

    const surface = await leakSurface(w);
    const links = await linkRows(w, s.activity.id);
    const mails = await invitations(w);
    expect(mails.length).toBeGreaterThan(5);
    for (const mail of mails) {
      for (const secret of [mail.secrets.token, mail.secrets.serial, mail.secrets.password]) {
        if (secret) expect(surface.includes(secret), `${mail.id} 的秘密出现在非 sealed 位置`).toBe(false);
      }
    }
    for (const link of links) {
      for (const digest of [link.serial_lookup, link.password_hash]) {
        if (digest) expect(surface.includes(digest)).toBe(false);
      }
    }
  });
});

/** 直接造 n 个 pending 链接和 awaiting_credential 邀请（绕过 500 次 API 调用）。 */
async function seedPending(w: World360, activityId: string, count: number) {
  const config = credentialConfig();
  const ids: string[] = [];
  await withTenant(w.db, w.tenantId, async (tx) => {
    const actor = randomUUID();
    const people = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      tenantId: w.tenantId,
      name: `批量评价者${i}`,
      email: `bulk-${i}-${randomUUID()}@example.com`,
      source: 'manual',
      createdBy: actor,
    }));
    await tx.insert(survey360People).values(people);
    const links = people.map((p) => ({
      id: randomUUID(),
      tenantId: w.tenantId,
      activityId,
      kind: 'answer',
      personId: p.id,
      tokenHash: `bulk-${randomUUID()}`,
      credentialState: 'pending',
    }));
    await tx.insert(survey360Links).values(links);
    const mails = links.map((l) => {
      const id = randomUUID();
      const eventType = 'survey360.answer_invitation';
      return {
        id,
        tenantId: w.tenantId,
        eventType,
        objectId: l.personId,
        commandId: 'seed',
        state: 'awaiting_credential',
        payload: {
          channel: 'email',
          activityId,
          personId: l.personId,
          linkId: l.id,
          sealed: sealJson(config, { token: `T-${l.id}` }, { tenantId: w.tenantId, outboxId: id, eventType }),
        },
      };
    });
    await tx.insert(survey360Outbox).values(mails);
    ids.push(...links.map((l) => l.id));
  });
  return ids;
}

describe('AC-360-F076-09 批量发放：有界批次、KDF 并发上限、崩溃重领、序列号冲突', () => {
  it('500 名评价者：每批 ≤ 100、KDF 并发 ≤ 2、最终全部 issued 且凭据互不相同', async () => {
    portalCredentials(true, { kdf: { N: 1024, r: 8, p: 1 } });
    const s = await sceneB(testDb().db, 'f076-09a');
    const { w } = s;
    await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:00:00Z') });
    await seedPending(w, s.activity.id, 500);
    resetKdfCallCount();

    const report = await runCredentialMaintenance(w.db, { clock: at('2026-10-01T03:00:00Z') });

    expect(report.issued).toBe(500);
    expect(report.batches).toEqual([100, 100, 100, 100, 100]);
    expect(kdfCallCount()).toBe(500);
    expect(kdfPeakConcurrency()).toBeLessThanOrEqual(2);
    const links = await linkRows(w, s.activity.id);
    expect(links.filter((l) => l.credential_state === 'issued')).toHaveLength(505);
    expect(new Set(links.map((l) => l.serial_lookup)).size).toBe(505);
  }, 120_000);

  it('生成后、写回前崩溃：库里仍是 pending，认领未过期时不重领，过期后重领一次发齐，无重复凭据', async () => {
    portalCredentials(true, { kdf: { N: 1024, r: 8, p: 1 } });
    const s = await sceneB(testDb().db, 'f076-09b');
    const { w } = s;

    await expect(
      runCredentialMaintenance(w.db, {
        clock: at('2026-10-01T02:00:00Z'),
        hooks: {
          beforeWriteBack: () => {
            throw new Error('simulated crash');
          },
        },
      }),
    ).rejects.toThrow('simulated crash');
    let links = await linkRows(w, s.activity.id);
    expect(links.every((l) => l.credential_state === 'pending' && l.serial_lookup === null)).toBe(true);
    expect(links.some((l) => l.credential_claimed_at !== null)).toBe(true);
    expect((await invitations(w)).every((m) => m.state === 'awaiting_credential')).toBe(true);

    // 认领未满 5 分钟：其他进程不会抢
    expect((await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:04:00Z') })).issued).toBe(0);
    // 满 5 分钟后重领
    expect((await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:06:00Z') })).issued).toBe(5);
    links = await linkRows(w, s.activity.id);
    expect(links.every((l) => l.credential_state === 'issued')).toBe(true);
    expect(new Set(links.map((l) => l.serial_lookup)).size).toBe(5);
    expect(await securityEvents(w, 'credential_issued')).toHaveLength(5);
  });

  it('序列号冲突：attempts + 1 并记 credential_error，释放认领；下一轮换新值成功', async () => {
    portalCredentials(true, { kdf: { N: 1024, r: 8, p: 1 } });
    const s = await sceneB(testDb().db, 'f076-09c');
    const { w } = s;

    // 随机源恒返回 0：所有行生成同一序列号，只有第一行写得进去
    const first = await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:00:00Z'), random: () => 0 });
    expect(first.issued).toBe(1);
    expect(first.conflicts).toBe(4);
    let links = await linkRows(w, s.activity.id);
    const stuck = links.filter((l) => l.credential_state === 'pending');
    expect(stuck).toHaveLength(4);
    expect(stuck.every((l) => l.credential_attempts === 1 && l.credential_error === 'SERIAL_CONFLICT')).toBe(true);
    expect(stuck.every((l) => l.credential_claimed_at === null)).toBe(true);
    expect((await invitations(w)).filter((m) => m.state === 'awaiting_credential')).toHaveLength(4);

    const second = await runCredentialMaintenance(w.db, { clock: at('2026-10-01T02:01:00Z') });
    expect(second.issued).toBe(4);
    links = await linkRows(w, s.activity.id);
    expect(links.every((l) => l.credential_state === 'issued')).toBe(true);
  });

  it('连续 5 次失败仍保持 pending，并写结构化运行日志提醒运维（不自动放弃）', async () => {
    portalCredentials(true, { kdf: { N: 1024, r: 8, p: 1 } });
    const s = await sceneB(testDb().db, 'f076-09d');
    const { w } = s;
    const warnings: { message: string; data: Record<string, unknown> }[] = [];
    const run = (clock: string) =>
      runCredentialMaintenance(w.db, {
        clock: at(clock),
        random: () => 0,
        hooks: { warn: (message, data) => warnings.push({ message, data }) },
      });
    await run('2026-10-01T02:00:00Z'); // 1 行成功，4 行 attempts = 1
    for (let i = 1; i <= 4; i += 1) await run(`2026-10-01T02:0${i}:00Z`);
    const links = await linkRows(w, s.activity.id);
    const stuck = links.filter((l) => l.credential_state === 'pending');
    expect(stuck).toHaveLength(4);
    expect(stuck.every((l) => l.credential_attempts === 5)).toBe(true);
    expect(warnings.some((x) => x.message === 'survey360.credential.issue_failing' && x.data['attempts'] === 5)).toBe(
      true,
    );
    // 日志不含明文
    expect(JSON.stringify(warnings)).not.toMatch(/2222222222/);
  });

  it('pending 超过 1 小时写运行日志告警（链接行的 created_at 取数据库时间，故用真实时钟推进）', async () => {
    portalCredentials(true);
    const s = await sceneB(testDb().db, 'f076-09e');
    const warnings: { message: string; data: Record<string, unknown> }[] = [];
    const hooks = {
      warn: (message: string, data: Record<string, unknown>) => warnings.push({ message, data }),
      beforeWriteBack: () => {
        throw new Error('simulated crash');
      },
    };
    const soon = () => new Date(Date.now() + 5 * 60_000);
    await expect(runCredentialMaintenance(s.w.db, { clock: soon, hooks })).rejects.toThrow('simulated crash');
    expect(warnings.some((x) => x.message === 'survey360.credential.pending_stale')).toBe(false);

    const later = () => new Date(Date.now() + 2 * 3_600_000);
    await expect(runCredentialMaintenance(s.w.db, { clock: later, hooks })).rejects.toThrow('simulated crash');
    const stale = warnings.find((x) => x.message === 'survey360.credential.pending_stale');
    expect(stale?.data['count']).toBe(5);
    expect(JSON.stringify(warnings)).not.toMatch(/token|password|serial/i);
  });
});
