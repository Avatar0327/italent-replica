/**
 * F-043 第 2 轮（#210 第 1 轮审查 P2-1 / P2-2，真 PG 交错；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * P2-1 范围复核之后、写入之前，组织侧把人员调出受限管理员的 360 人员范围，同步仍写入了该人员。三处同类入口都要
 *   在**实际写入时**确认目标仍可管理（先对员工行加共享锁挡住组织侧调动，再重读最新快照与范围）：
 *   普通同步（员工分页）、上级回补（回补分页）、评价者导入选择“同步”时的组织信息刷新。已调出范围的跳过并记审计。
 * P2-2 同步中途收窄或撤空管理员的 360 范围：写命令执行时重新取得管理范围（不沿用路由层缓存），首次回执同样按
 *   查看人当前范围裁剪。
 * 做法：用测试探针在“写入已决定、尚未复核”处暂停，让另一连接完成调动 / 改范围，再放行并核对结果前后的值。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { commandProbe } from '../../apps/api/src/modules/survey360/context.js';
import { syncProbe } from '../../apps/api/src/modules/survey360/sync.js';
import { scene, type SyncPage } from './AC-360-F043-support.js';
import { expectWaitingOnLock } from './support/f061.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
const world = (label: string) => scene(testDb().db, label, true);

afterEach(() => {
  syncProbe.beforeWrite = undefined;
  commandProbe.beforeCommand = undefined;
  commandProbe.beforePresent = undefined;
});

/** 探针只对指定员工触发一次。 */
function onceFor(employeeId: string, action: () => Promise<void>) {
  syncProbe.beforeWrite = async (id) => {
    if (id !== employeeId) return;
    syncProbe.beforeWrite = undefined;
    await action();
  };
}

describe.skipIf(!realPostgres)('F-043 P2-1 写入前复核的是最新状态（真 PG）', () => {
  it('普通同步：通过复核后、写入前员工被调出范围 → 不写（名称、revision 不变），回执看不到，记 sync_skipped 审计', async () => {
    const s = await world('f043r1');
    onceFor(s.inside.id, () => s.transferOut(s.inside.id));
    const page = await s.w.ok<SyncPage>(s.sync());
    const inside = await s.current(s.insidePerson.id);
    expect(inside.name).toBe(s.insidePerson.name);
    expect(inside.revision).toBe(s.insidePerson.revision);
    expect(JSON.stringify(page)).not.toContain(s.inside.id);
    expect((await s.skippedLogs(s.w.admin)).map((log) => log.objectId)).toContain(s.insidePerson.id);
    expect(await s.skippedLogs(s.admin)).toEqual([]);
  });

  it('上级回补：回补阶段通过复核后、写入前员工被调出范围 → 不写（上级仍为空、名称不变）', async () => {
    const s = await world('f043r2');
    // 范围内员工的上级先清空：回补阶段会按直线经理补上
    const seen = await s.current(s.insidePerson.id);
    await s.w.ok(
      s.w.request('PUT', `/people/${seen.id}`, {
        ifMatch: seen.revision,
        body: { name: seen.name, superiorPersonId: null },
      }),
    );
    const before = await s.current(s.insidePerson.id);
    expect(before.superiorPersonId ?? null).toBeNull();
    onceFor(s.inside.id, () => s.transferOut(s.inside.id));
    await s.w.ok<SyncPage>(s.sync(randomUUID(), { after: 'backfill:' }));
    const after = await s.current(s.insidePerson.id);
    expect(after.superiorPersonId ?? null).toBeNull();
    expect(after.name).toBe(before.name);
    expect(after.revision).toBe(before.revision);
    expect((await s.skippedLogs(s.w.admin)).map((log) => log.objectId)).toContain(s.insidePerson.id);
  });

  it('评价者导入选择“同步”：刷新前员工被调出范围 → 不刷新（名称、revision 不变），记 sync_skipped 审计', async () => {
    const s = await world('f043r3');
    const q = await s.w.enableQuestionnaire(await s.w.keyBehavior());
    const activity = await s.w.activity({ name: 'F-043 导入活动' }, s.admin);
    await s.w.ok(
      s.as('POST', `/activities/${activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: s.managerPerson.id, questionnaireIds: [q.id] },
      }),
      201,
    );
    onceFor(s.inside.id, () => s.transferOut(s.inside.id));
    const imported = await s.as('POST', `/activities/${activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: {
        sync: true,
        rows: [
          { objectEmail: s.managerPerson.email, roleId: s.w.role('peer'), name: '导入名', email: s.insidePerson.email },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBeLessThan(500);
    const inside = await s.current(s.insidePerson.id);
    expect(inside.name).toBe(s.insidePerson.name);
    expect(inside.revision).toBe(s.insidePerson.revision);
    expect((await s.skippedLogs(s.w.admin)).map((log) => log.objectId)).toContain(s.insidePerson.id);
  });
});

describe.skipIf(!realPostgres)('F-043 P2-1 写入处先锁员工行（真 PG）', () => {
  it('组织侧（任职写入）持着员工行排他锁时，同步在员工行上等待；组织侧提交后同步按提交后的状态复核并照常写入范围内人员', async () => {
    const s = await world('f043r6');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
    const org = withTenant(testDb().db, s.w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE id = ${s.inside.id}::uuid FOR UPDATE`);
      locked();
      await hold;
    });
    await lockedPromise;
    const syncing = s.sync();
    await expectWaitingOnLock(testDb().db, syncing);
    release();
    await org;
    const page = await s.w.ok<SyncPage>(syncing);
    expect(page.updated.map((e) => e.employeeId)).toEqual([s.inside.id]);
    expect((await s.current(s.insidePerson.id)).name).toBe('范围内新名');
  });
});

describe.skipIf(!realPostgres)('F-043 P2-2 管理范围在请求中途收窄 / 撤空（真 PG）', () => {
  it('写命令执行时重新取得管理范围：路由层取范围之后、执行之前被撤空 → 不写任何人员，回执为空', async () => {
    const s = await world('f043r4');
    commandProbe.beforeCommand = async () => {
      commandProbe.beforeCommand = undefined;
      await s.emptyScope();
    };
    const page = await s.w.ok<SyncPage>(s.sync());
    const inside = await s.current(s.insidePerson.id);
    expect(inside.name).toBe(s.insidePerson.name);
    expect(inside.revision).toBe(s.insidePerson.revision);
    expect(page.updated).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(s.inside.id);
  });

  it('首次回执按查看人当前范围裁剪：命令提交之后、回执之前被撤空 → 回执不带已写入的人员（重放同样）', async () => {
    const s = await world('f043r5');
    const key = randomUUID();
    commandProbe.beforePresent = async () => {
      commandProbe.beforePresent = undefined;
      await s.emptyScope();
    };
    const first = await s.w.ok<SyncPage>(s.sync(key));
    expect((await s.current(s.insidePerson.id)).name).toBe('范围内新名');
    expect(first.updated).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(s.inside.id);
    const replay = await s.w.ok<SyncPage>(s.sync(key));
    expect(replay.updated).toEqual([]);
    expect(JSON.stringify(replay)).not.toContain(s.inside.id);
  });
});
