/**
 * AC-360-F076-10、11（F-076 PR-1，设计 §2.4、§2.4.1）：运维命令 rotate / retire / stats。
 * 三代密钥、计划退役、泄露处置（含已迁移与此前已退役的凭据）、中断与续跑、手动重发清单。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { credentialStats, retireKeys, rotateKeys } from '../../apps/api/src/modules/survey360/credential-ops.js';
import { sceneB } from './AC-360-B-support.js';
import {
  addSession,
  linkRows,
  portalCredentials,
  resetCredentialConfig,
  securityEvents,
  sessionStates,
  setCredential,
} from './AC-360-F076-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());
const at = (iso: string) => () => new Date(iso);
const FAST = { N: 1024, r: 8, p: 1 };
const keyMap = (...versions: number[]) => new Map(versions.map((v) => [v, randomBytes(32)]));

/** 以 versions 为密钥表、current 为当前版本打开开关；已有密钥沿用（同一版本号对应同一密钥）。 */
const known = new Map<number, Buffer>();
function configure(versions: number[], current: number, extra: { retired?: number[]; compromised?: number[] } = {}) {
  for (const v of versions) if (!known.has(v)) known.set(v, keyMap(v).get(v)!);
  const credentialKeys = new Map(versions.map((v) => [v, known.get(v)!]));
  portalCredentials(true, {
    credentialKeys,
    currentVersion: current,
    retiredVersions: new Set(extra.retired ?? []),
    compromisedVersions: new Set(extra.compromised ?? []),
    kdf: FAST,
  });
  return credentialConfig();
}

describe('AC-360-F076-11 retire 中断与续跑', () => {
  it('计划退役：第一批后注入失败，进度行 failed 且已持久；续跑后总数与一次跑完相同，最后一条 key_retired', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-11a');
    const { w } = s;
    await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: at('2026-10-01T02:00:00Z') });
    const cfg = configure([2], 2, { retired: [1] });

    await expect(
      retireKeys(w.db, {
        tenantId: w.tenantId,
        version: 1,
        compromised: false,
        config: cfg,
        batchSize: 2,
        hooks: {
          afterBatch: ({ batch }) => {
            if (batch === 1) throw new Error('simulated failure');
          },
        },
      }),
    ).rejects.toThrow('simulated failure');

    const [run] = await runRows(w);
    expect(run).toMatchObject({ status: 'failed', credentials_done: 2, sessions_done: 0, attempts: 1 });
    expect(run!.cursor_link_id).not.toBeNull();
    expect(await securityEvents(w, 'credential_revoked')).toHaveLength(1);
    expect(await securityEvents(w, 'key_retired')).toHaveLength(0);

    const resumed = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: false,
      config: cfg,
      batchSize: 2,
      resumeRunId: run!.run_id,
    });
    expect(resumed.tenants[0]).toMatchObject({ status: 'done', credentials: 5, sessions: 0 });
    expect((await linkRows(w, s.activity.id)).every((l) => l.credential_state === 'retired')).toBe(true);
    const revoked = await securityEvents(w, 'credential_revoked');
    // 同一次运行的事件 occurred_at 相同、id 随机，只比较各批数量的多重集
    expect(revoked.map((e) => e.detail['credentials']).sort()).toEqual([1, 2, 2]);
    const [done] = await securityEvents(w, 'key_retired');
    expect(done).toMatchObject({ compromised: false, run_id: run!.run_id, credential_key_version: 1 });
    expect(done!.detail).toMatchObject({ credentials: 5, sessions: 0 });
    // 已完成的运行再续跑是幂等的
    const again = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: false,
      config: cfg,
      resumeRunId: run!.run_id,
    });
    expect(again.tenants[0]).toMatchObject({ status: 'done', credentials: 5 });
    expect(await securityEvents(w, 'key_retired')).toHaveLength(1);
  });

  it('泄露处置：集合含该版本的行都处理（含已迁移的、此前已计划退役的），作废其链接上的全部会话；未用过该版本的不动', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-11b');
    const { w } = s;
    const links = await linkRows(w, s.activity.id);
    const byPerson = (id: string) => links.find((l) => l.person_id === id)!.id;
    const A = byPerson(s.person.T.id); // k1 发放，从未迁移
    const B = byPerson(s.person.M.id); // k1 发放，已迁移到 k2（集合 {1,2}）
    const C = byPerson(s.person.P1.id); // 此前已计划退役（集合 {1}）
    const D = byPerson(s.person.P2.id); // k2 发放后迁移到 k3，从未用过 k1（集合 {2,3}）
    const E = byPerson(s.person.X.id); // 集合含 1，但链接已作废：会话要清，不进重发清单
    await setCredential(w, A, { state: 'issued', version: 1 });
    await setCredential(w, B, { state: 'issued', version: 2, versions: [1, 2] });
    await setCredential(w, C, { state: 'retired', version: 1 });
    await setCredential(w, D, { state: 'issued', version: 3, versions: [2, 3] });
    await setCredential(w, E, { state: 'issued', version: 1, revoked: true });
    for (const [name, link] of [
      ['a', A],
      ['b', B],
      ['c', C],
      ['d', D],
      ['e', E],
    ] as const) {
      await addSession(w, link, `${name}1`);
      await addSession(w, link, `${name}2`);
    }
    const cfg = configure([2, 3], 3, { retired: [1], compromised: [1] });

    // 前置检查：泄露处置要求版本在 COMPROMISED 里
    await expect(
      retireKeys(w.db, {
        tenantId: w.tenantId,
        version: 1,
        compromised: true,
        config: configure([2, 3], 3, { retired: [1] }),
      }),
    ).rejects.toThrow(/COMPROMISED/);

    const run = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: true,
      config: cfg,
      batchSize: 2,
    });

    expect(run.tenants[0]).toMatchObject({ status: 'done', credentials: 3, sessions: 8 });
    const after = new Map((await linkRows(w, s.activity.id)).map((l) => [l.id, l]));
    for (const id of [A, B, C, E]) {
      expect(after.get(id)).toMatchObject({ credential_state: 'retired', serial_lookup: null, password_hash: null });
      expect(await sessionStates(w, id)).toEqual([true, true]);
    }
    expect(after.get(B)!.credential_key_versions).toEqual([1, 2]);
    expect(after.get(D)).toMatchObject({ credential_state: 'issued', credential_key_version: 3 });
    expect(await sessionStates(w, D)).toEqual([false, false]);

    // 清单：A、B、C（链接未作废）；E 作废、D 未暴露不在内；不含任何凭据
    expect(run.tenants[0]!.resend).toEqual([{ activityId: s.activity.id, linkIds: [A, B, C].sort(), count: 3 }]);
    const events = await securityEvents(w, 'credential_revoked');
    expect(events.reduce((n, e) => n + (e.detail['sessions'] as number), 0)).toBe(8);
    expect(events.every((e) => e.compromised === true)).toBe(true);
    const [retired] = await securityEvents(w, 'key_retired');
    expect(retired!.detail).toMatchObject({ credentials: 3, sessions: 8 });
  });

  it('先计划退役、后判定泄露：先退役的凭据，其会话在泄露处置时才被清理', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-11c');
    const { w } = s;
    const [first] = await linkRows(w, s.activity.id);
    await setCredential(w, first!.id, { state: 'issued', version: 1 });
    await addSession(w, first!.id, 'k1');

    await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: false,
      config: configure([2], 2, { retired: [1] }),
    });
    expect(await sessionStates(w, first!.id)).toEqual([false]); // 计划退役不动会话

    const run = await retireKeys(w.db, {
      tenantId: w.tenantId,
      version: 1,
      compromised: true,
      config: configure([2], 2, { retired: [1], compromised: [1] }),
    });
    expect(await sessionStates(w, first!.id)).toEqual([true]);
    expect(run.tenants[0]!.sessions).toBe(1);
    expect(run.tenants[0]!.resend[0]!.linkIds).toContain(first!.id);
  });
});

// 已登记的密钥版本是全局的、只增不减（设计 §2.4，credential-key-registry.ts），同一测试库里登记过 k3 之后不能再发 k1 凭据：
// 所以只用 k1 发放的 F076-11 放在前面，含 rotate 的 F076-10 放在最后。
describe('AC-360-F076-10 三代密钥与计划退役', () => {
  it('新发放依次用 1、2、3；rotate 每租户一条 key_rotated；retire 只处理 k1，k2 / k3 不变；k1 仍在 KEYS 时拒绝执行', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-10');
    const { w } = s;
    const db = w.db;
    await runCredentialMaintenance(db, { tenantId: w.tenantId, clock: at('2026-10-01T02:00:00Z') });
    const batch1 = (await linkRows(w, s.activity.id)).map((l) => l.id);
    expect((await linkRows(w, s.activity.id)).every((l) => l.credential_key_version === 1)).toBe(true);

    // 第二代：先拒绝不合规的 rotate
    let cfg = configure([1, 2], 2);
    await expect(rotateKeys(db, { to: 3, config: cfg })).rejects.toThrow(/KEYS|CURRENT/);
    const rotated2 = await rotateKeys(db, { to: 2, config: cfg });
    // 每个启用 / 停用租户各一条（库里还有前面用例的租户）
    expect(rotated2.written).toBe(rotated2.tenants);
    expect((await securityEvents(w, 'key_rotated')).length).toBe(1);
    // 同版本再跑一次不重复写（每租户一条）
    expect((await rotateKeys(db, { to: 2, config: cfg })).written).toBe(0);
    // 重发邮件邀请产生第二批（新行 pending）
    w.setNow('2026-10-01T05:00:00Z');
    await w.ok(
      w.request('POST', `${s.path}/invitations`, {
        idempotencyKey: randomUUID(),
        body: { personIds: [s.person.X.id, s.person.P1.id, s.person.P2.id] },
      }),
    );
    await runCredentialMaintenance(db, { tenantId: w.tenantId, clock: at('2026-10-01T06:00:00Z') });

    // 第三代
    cfg = configure([1, 2, 3], 3);
    // 版本只增不减：已登记到 2 之后不能再 rotate 回 1
    await expect(rotateKeys(db, { to: 1, config: configure([1, 2, 3], 1) })).rejects.toThrow(/大于|不小于|previous/);
    configure([1, 2, 3], 3);
    await rotateKeys(db, { to: 3, config: cfg });
    w.setNow('2026-10-01T07:00:00Z');
    await w.ok(
      w.request('POST', `${s.path}/invitations`, {
        idempotencyKey: randomUUID(),
        body: { personIds: [s.person.X.id] },
      }),
    );
    await runCredentialMaintenance(db, { tenantId: w.tenantId, clock: at('2026-10-01T08:00:00Z') });

    const issuedBy = async () => {
      const all = await linkRows(w, s.activity.id);
      const by = new Map<number, string[]>();
      for (const l of all.filter((x) => !x.revoked && x.credential_state === 'issued')) {
        by.set(l.credential_key_version!, [...(by.get(l.credential_key_version!) ?? []), l.id]);
      }
      return by;
    };
    const by = await issuedBy();
    expect([...by.keys()].sort()).toEqual([1, 2, 3]);
    expect(by.get(1)).toHaveLength(2); // T、M 仍是第一代
    expect(by.get(2)).toHaveLength(2); // P1、P2 在第二代重发
    expect(by.get(3)).toHaveLength(1); // X 在第三代重发
    expect(batch1).toHaveLength(5);

    const rotated = await securityEvents(w, 'key_rotated');
    expect(rotated.map((e) => [e.credential_key_version, e.detail['previous']])).toEqual([
      [2, 1],
      [3, 2],
    ]);

    // stats：仍以 k1 存摘要的数量
    expect(await credentialStats(db, { version: 1 })).toEqual([
      { tenantId: w.tenantId, activityId: s.activity.id, count: 2 },
    ]);

    // 版本仍在 KEYS：拒绝
    await expect(retireKeys(db, { tenantId: w.tenantId, version: 1, compromised: false, config: cfg })).rejects.toThrow(
      /KEYS|RETIRED/,
    );
    // 1 移入 RETIRED（2、3 保留）后执行
    cfg = configure([2, 3], 3, { retired: [1] });
    const run = await retireKeys(db, { tenantId: w.tenantId, version: 1, compromised: false, config: cfg });
    expect(run.tenants[0]).toMatchObject({ status: 'done', credentials: 5, sessions: 0 });

    const after = await linkRows(w, s.activity.id);
    for (const link of after.filter((l) => !l.revoked)) {
      if (link.credential_key_version === 1) {
        expect(link).toMatchObject({ credential_state: 'retired', serial_lookup: null, password_hash: null });
        expect(link.credential_key_versions).toEqual([1]);
      } else {
        expect(link.credential_state).toBe('issued');
      }
    }
    expect((await issuedBy()).get(2)).toHaveLength(2);
    expect((await issuedBy()).get(3)).toHaveLength(1);
    // 需要手动重发的评价者清单（计划退役同样输出），不含凭据
    expect(run.tenants[0]!.resend).toEqual([{ activityId: s.activity.id, linkIds: expect.any(Array), count: 2 }]);
    expect(JSON.stringify(run)).not.toMatch(/scrypt|lookup/);
  });
});

async function runRows(w: { db: Db; tenantId: string }) {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT run_id, status, cursor_link_id, credentials_done, sessions_done, attempts
      FROM survey360_key_retire_runs ORDER BY started_at`),
  );
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    run_id: string;
    status: string;
    cursor_link_id: string | null;
    credentials_done: number;
    sessions_done: number;
    attempts: number;
  }[];
}
