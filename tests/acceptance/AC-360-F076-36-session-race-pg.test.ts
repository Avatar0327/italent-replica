/** §3.5.1：真实删除事务持活动 UPDATE 时，会话定位等待 KEY SHARE，提交后按现值拒绝。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { linkHooks } from '../../apps/api/src/modules/survey360/links.js';
import { resetCredentialConfig, rowsOf } from './AC-360-F076-support.js';
import { issuedScene, loginOk, sessionCall } from './AC-360-F076-portal-support.js';
import { blockedOrSettled, gate } from './AC-360-F076-lock-barrier.js';
import { withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  linkHooks.afterTaskCheck = undefined;
});
describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-360-F076-36 会话与删除交错（真 PG）', () => {
  it('最后关系删除尚未提交，预检通过的会话写入须等待活动锁；删除提交后 404、无答卷与命令台账', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'session-race');
    const { session } = await loginOk(w, creds.get(s.person.P1.id)!);
    const held = gate();
    linkHooks.afterTaskCheck = async () => {
      held.reached();
      await held.wait;
    };
    const removing = w.request('DELETE', `${s.path}/objects/${s.object.id}/appraisers/${s.rel.p1.id}`, {
      ifMatch: s.rel.p1.revision,
    });
    await held.arrived;
    const command = crypto.randomUUID();
    const saving = sessionCall(w, session)('PUT', `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`, {
      ifMatch: 0,
      idempotencyKey: command,
      body: { answers: [], suggestion: '不得保存' },
    });
    await withRelease(
      () => held.release(),
      async (cleanup) => {
        [removing, saving].forEach((request) => cleanup.track<unknown>(request));
        await blockedOrSettled(w.db, saving);
      },
    );
    expect((await removing).status).toBe(200);
    expect((await saving).status).toBe(404);
    const result = await withTenant(w.db, w.tenantId, async (tx) => ({
      sheets: rowsOf(await tx.execute(sql`SELECT id FROM survey360_sheets WHERE relation_id = ${s.rel.p1.id}::uuid`)),
      commands: rowsOf(await tx.execute(sql`SELECT command_id FROM command_ledger WHERE command_id = ${command}`)),
    }));
    expect(result).toEqual({ sheets: [], commands: [] });
  });
});
