/** AC-35/41/42：会话以链接当前暴露版本为准，计划退役不提前结束会话。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { retireKeys } from '../../apps/api/src/modules/survey360/credential-ops.js';
import { portalCredentials, resetCredentialConfig, rowsOf, securityEvents } from './AC-360-F076-support.js';
import { FAST, issuedScene, loginOk, sessionCall, sessionRows } from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(resetCredentialConfig);
const keys = new Map([1, 2, 3].map((v) => [v, randomBytes(32)]));
const configure = (current: number, retired: number[] = [], compromised: number[] = []) => {
  portalCredentials(true, {
    kdf: FAST,
    currentVersion: current,
    credentialKeys: new Map([...keys].filter(([v]) => !retired.includes(v))),
    retiredVersions: new Set(retired),
    compromisedVersions: new Set(compromised),
  });
};

describe('AC-360-F076-35/41/42 会话密钥生命周期', () => {
  it('AC-35/41：签发后的迁移也追溯旧会话；跳过泄露版本的会话不受影响；批处理中断和续跑', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'session-keys', {
      currentVersion: 1,
      credentialKeys: keys,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const p1 = creds.get(s.person.P1.id)!;
    const old = await loginOk(w, p1);
    configure(2);
    const migrated = await loginOk(w, p1);
    const v2 = await issuedScene(testDb().db, 'session-issued-v2', {
      currentVersion: 2,
      credentialKeys: keys,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const v2Session = await loginOk(v2.w, v2.creds.get(v2.s.person.P1.id)!);
    configure(3);
    const skipped = await loginOk(w, creds.get(s.person.P2.id)!);
    configure(3, [2], [2]);
    const paths = ['', `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`, `/avatars/${randomUUID()}/content`];
    const check = async () => {
      for (const path of [
        '',
        `/tasks/${v2.s.rel.p1.id}/questionnaires/${v2.s.q.id}`,
        `/avatars/${randomUUID()}/content`,
      ])
        expect((await sessionCall(v2.w, v2Session.session)('GET', path)).status).toBe(401);
      for (const { session } of [old, migrated])
        for (const path of paths) expect((await sessionCall(w, session)('GET', path)).status).toBe(401);
      expect((await sessionCall(w, skipped.session)('GET')).status).toBe(200);
    };
    await check();
    await expect(
      retireKeys(w.db, {
        tenantId: w.tenantId,
        version: 2,
        compromised: true,
        config: credentialConfig(),
        batchSize: 1,
        hooks: {
          afterBatch: () => {
            throw new Error('中断批处理');
          },
        },
      }),
    ).rejects.toThrow('中断批处理');
    await check();
    const [run] = rowsOf<{ run_id: string }>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT run_id FROM survey360_key_retire_runs WHERE credential_key_version = 2`),
      ),
    );
    const done = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 2,
      compromised: true,
      config: credentialConfig(),
      resumeRunId: run!.run_id,
    });
    expect(done.tenants[0]).toMatchObject({ credentials: 1, sessions: 2, status: 'done' });
    await check();
    expect((await sessionRows(w, p1.linkId)).every((row) => row.revoked_at !== null)).toBe(true);
    expect((await sessionRows(w, creds.get(s.person.P2.id)!.linkId))[0]!.revoked_at).toBeNull();
    const v2Done = await retireKeys(v2.w.db, {
      tenantId: v2.w.tenantId,
      version: 2,
      compromised: true,
      config: credentialConfig(),
    });
    expect(v2Done.tenants[0]).toMatchObject({ credentials: 5, sessions: 1 });
    await check();
    expect((await securityEvents(w, 'key_retired'))[0]!.detail).toMatchObject({ credentials: 1, sessions: 2 });
  });

  it('AC-35/42：计划退役后能读；后来判定泄露立即拒绝，批处理也清理已经 retired 的链接会话', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'session-retired', {
      currentVersion: 1,
      credentialKeys: keys,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const cred = creds.get(s.person.P1.id)!;
    const { session } = await loginOk(w, cred);
    const call = sessionCall(w, session);
    configure(2, [1]);
    await retireKeys(w.db, { tenantId: w.tenantId, version: 1, compromised: false, config: credentialConfig() });
    expect((await call('GET')).status).toBe(200);
    expect((await call('GET', `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`)).status).toBe(200);
    configure(2, [1], [1]);
    expect((await call('GET')).status).toBe(401);
    const done = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: true,
      config: credentialConfig(),
    });
    expect(done.tenants[0]).toMatchObject({ credentials: 0, sessions: 1 });
    expect((await sessionRows(w, cred.linkId))[0]!.revoked_at).not.toBeNull();
    expect(done.tenants[0]!.resend.flatMap((group) => group.linkIds)).toContain(cred.linkId);
    expect((await call('GET')).status).toBe(401);
    expect((await securityEvents(w, 'key_retired')).filter((e) => e.compromised)).toHaveLength(1);
  });
});
