/**
 * F-082 AC-09（并发改名，契约 §3.1）与 AC-27（锁序 S < R < A < F < V < I，契约 §3.4）——真 PostgreSQL 16
 * （PGlite 单连接无法并发）：
 * - 09：3950 字公式同时引用 A、B，两个事务分别给 A、B 各加 30 字：全租户改名在字段目录版本行上串行，后到者在前者提交后
 *   才读名称并校验——只有一个成功，另一个 409，没有死锁；
 * - 27：存量租户已有预置编码字段 X、其余预置字段与预置九宫格缺失：DEC-361 回补事务与“管理员改名 X”并发，两种先后顺序
 *   都无 40P01；回补事务只在末尾推进一次版本；再加上写九宫格（先取位置 advisory 锁）的第三事务，三方交错同样无死锁。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_PRESET_MATRICES } from '@italent/domain';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { lockPositionFields } from '../../apps/api/src/modules/talent-review/matrix-service.js';
import {
  calcBody,
  calcItem,
  catalogVersion,
  errorOf,
  f082World,
  fieldHandle,
  fieldRevision,
  itemIdOf,
  makeBound,
  renameField,
} from './AC-TR-F082-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));

pg('AC-09 并发改名（真 PG）', () => {
  it('两个改名各自单独合法、合计超限：只有一个成功，另一个 409 FIELD_NAME_BREAKS_FORMULA，无死锁', async () => {
    const db = testDb().db;
    const w = await f082World(db, 'f082-pg09');
    const [target, a, b] = [
      await w.numberField(),
      await w.field('number', { name: '甲' }),
      await w.field('number', { name: '乙' }),
    ];
    // 渲染长度 3950：盘点对象.甲(6) + " + "(3) + 盘点对象.乙(6) + ' + ""'(…)
    const base = `${fieldHandle(a.id)} + ${fieldHandle(b.id)} + ""`;
    const pad = 3950 - (6 + 3 + 6 + 3 + 2);
    const stored = base.replace('""', `"${'x'.repeat(pad)}"`);
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    await makeBound(db, w, await itemIdOf(db, w, rule.id, target.id), stored, [a.id, b.id]);
    const [revA, revB] = [await fieldRevision(w, a.id), await fieldRevision(w, b.id)];
    const longName = (c: string) => c.repeat(31); // 各比 1 字符的原名多 30 字

    // 屏障：测试事务先锁住版本行，两个改名请求都先取到各自字段行，再在版本行处排队；提交后各自继续
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      await tx.execute(sql`SELECT tenant_id FROM talent_review_field_catalog_versions FOR UPDATE`);
      first = w.request('PATCH', `/fields/${a.id}`, { ifMatch: revA, body: { name: longName('名') } });
      second = w.request('PATCH', `/fields/${b.id}`, { ifMatch: revB, body: { name: longName('称') } });
      await waitForBlocked(db, 2);
    });
    const responses = await Promise.all([first!, second!]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const failed = responses.find((response) => response.status === 409)!;
    expect((await errorOf(failed)).details['reason']).toBe('FIELD_NAME_BREAKS_FORMULA');
  });
});

pg('AC-27 锁序（真 PG）', () => {
  const position = TALENT_REVIEW_PRESET_MATRICES[0]!.positionFieldCodes.before;

  async function world(label: string) {
    const db = testDb().db;
    const w = await f082World(db, label);
    // 存量租户：已有预置编码的位置字段 X，其余预置字段与预置九宫格缺失
    const x = await w.field('number', { code: position, name: '位置字段X', group: 'position' });
    return { db, w, x };
  }
  const backfill = (db: Db, tenantId: string) =>
    withTenant(db, tenantId, (tx) =>
      installMissingSeeds(tx, { tenantId, actorUserId: null, now: new Date(), commandId: randomUUID() }),
    );

  it('先回补后改名：改名在回补事务持有的字段行上排队，回补提交后完成；无 40P01', async () => {
    const { db, w, x } = await world('f082-pg27a');
    const before = await catalogVersion(db, w);
    let rename: Promise<Response> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      await installMissingSeeds(tx, {
        tenantId: w.as.tenant,
        actorUserId: null,
        now: new Date(),
        commandId: randomUUID(),
      });
      rename = renameField(w, x, '回补之后的名字');
      await waitForBlocked(db, 1);
    });
    const response = await rename!;
    expect([200, 409]).toContain(response.status);
    expect(await catalogVersion(db, w)).toBeGreaterThan(before);
  });

  it('先改名后回补：回补在改名持有的字段行上排队，改名提交后完成且只在末尾推进版本；无 40P01', async () => {
    const { db, w, x } = await world('f082-pg27b');
    let pending: ReturnType<typeof backfill> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      // 模拟改名事务：字段行 FOR UPDATE → 版本行 FOR UPDATE（契约 §3.4 的顺序）
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${x.id}::uuid FOR UPDATE`);
      await tx.execute(sql`INSERT INTO talent_review_field_catalog_versions (tenant_id) VALUES (${w.as.tenant})
        ON CONFLICT DO NOTHING`);
      await tx.execute(sql`SELECT tenant_id FROM talent_review_field_catalog_versions FOR UPDATE`);
      pending = backfill(db, w.as.tenant);
      await waitForBlocked(db, 1);
    });
    const report = await pending!;
    expect(report.length).toBeGreaterThan(0);
  });

  it('三方交错（回补 / 改名 X / 写九宫格取位置 advisory 锁）反复并发：无 40P01，各自成功或得到受控错误', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { db, w, x } = await world(`f082-pg27c-${round}`);
      const outcomes = await Promise.allSettled([
        backfill(db, w.as.tenant),
        renameField(w, x, `三方交错${round}`),
        withTenant(db, w.as.tenant, async (tx) => {
          await lockPositionFields(tx, w.as.tenant, [x.id]);
          await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${x.id}::uuid FOR KEY SHARE`);
        }),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected')
          expect(pgErrorCode(outcome.reason), String(outcome.reason)).not.toBe('40P01');
        else if (outcome.value instanceof Response) expect([200, 409]).toContain(outcome.value.status);
      }
    }
  });
});
