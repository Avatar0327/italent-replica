/**
 * AC-ESIGN-F505-01 三场景来源约束（设计 §4.1、§4.2、§12）：新 Offer / 入职任务可落库；来源双填、空填、错误场景、
 * 跨租户外键拒绝；同人的 Offer 与入职各可有一条签署中，同来源第二条签署中失败。
 * 真库（PGlite 与 PG16 app_owner 两套）；库级约束，不走 HTTP（S1 没有发起路由）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  sourceWorld,
  sqlState,
} from './AC-ESIGN-F505-support.js';

const db = useTestDb();

describe('AC-ESIGN-F505-01 三场景来源约束', () => {
  it('新 Offer 场景与入职场景任务可落库；同人 Offer 与入职各一条签署中互不阻塞', async () => {
    const w = await sourceWorld(db().db, 'ok');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const employeeId = w.person.employee.id;
    const offerTask = await w.task({ scene: 'offer', offerId, employeeId, sourceRevision: 3 });
    const entryTask = await w.task({ scene: 'entry', businessId: w.entryBusinessId, employeeId, sourceRevision: 1 });
    expect(offerTask).not.toBe(entryTask);
    expect(await w.taskCount()).toBe(2);
  });

  it('来源双填、空填、场景与来源列错配、未知场景一律被约束拒绝', async () => {
    const w = await sourceWorld(db().db, 'bad');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const employeeId = w.person.employee.id;
    const businessId = w.entryBusinessId;
    const rejected = async (seed: Parameters<typeof w.task>[0]) => sqlState(() => w.task(seed));
    const base = { employeeId, sourceRevision: 1 };
    expect(await rejected({ ...base, scene: 'offer', offerId, businessId }), 'offer 双填').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'entry', offerId, businessId }), 'entry 双填').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'offer' }), 'offer 空填').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'entry' }), 'entry 空填').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'offer', businessId }), 'offer 场景填业务列').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'entry', offerId }), 'entry 场景填 Offer 列').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'transfer', offerId }), 'transfer 场景填 Offer 列').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...base, scene: 'bogus', businessId }), '未知场景').toBe(CHECK_VIOLATION);
    expect(await w.taskCount()).toBe(0);
  });

  it('来源修订号、来源、变量字段与发起方式的约束', async () => {
    const w = await sourceWorld(db().db, 'cols');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const employeeId = w.person.employee.id;
    const businessId = w.entryBusinessId;
    const rejected = async (seed: Parameters<typeof w.task>[0]) => sqlState(() => w.task(seed));
    const entry = { scene: 'entry', businessId, employeeId } as const;
    expect(await rejected({ ...entry, sourceRevision: null }), 'entry 必须记来源修订号').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...entry, sourceRevision: 0 }), '来源修订号必须为正').toBe(CHECK_VIOLATION);
    expect(await rejected({ scene: 'offer', offerId, employeeId }), 'offer 必须记来源修订号').toBe(CHECK_VIOLATION);
    expect(await rejected({ ...entry, sourceRevision: 1, origin: 'activation' }), '新场景只能手动发起').toBe(
      CHECK_VIOLATION,
    );
    expect(await rejected({ ...entry, sourceRevision: 1, variableReadFields: '{phone}' }), '字段只许 name/code').toBe(
      CHECK_VIOLATION,
    );
    expect(await rejected({ ...entry, sourceRevision: 1, variableReadFields: '{name,name}' }), '字段须去重').toBe(
      CHECK_VIOLATION,
    );
    expect(await sqlState(() => w.task({ ...entry, sourceRevision: 1, variableReadFields: '{name,code}' }))).toBe('ok');
  });

  it('Offer 任务必须指向本租户已建锚点的 Offer：无锚点、跨租户锚点都被外键拒绝', async () => {
    const a = await sourceWorld(db().db, 'ta');
    const b = await sourceWorld(db().db, 'tb');
    const offerId = await a.offer();
    await a.anchor(offerId);
    const seed = { scene: 'offer', offerId, sourceRevision: 1 } as const;
    const unanchored = await b.offer();
    expect(await sqlState(() => b.task({ ...seed, offerId: unanchored, employeeId: b.person.employee.id }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    // 租户 B 用租户 A 的锚点造任务：复合外键含租户，不匹配
    expect(await sqlState(() => b.task({ ...seed, employeeId: b.person.employee.id }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await a.taskCount()).toBe(0);
  });

  it('同来源第二条签署中失败；终态后可再发新任务（含已完成）', async () => {
    const w = await sourceWorld(db().db, 'one');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const employeeId = w.person.employee.id;
    const businessId = w.entryBusinessId;
    const offerSeed = { scene: 'offer', offerId, employeeId, sourceRevision: 2 } as const;
    const entrySeed = { scene: 'entry', businessId, employeeId, sourceRevision: 2 } as const;
    await w.task(offerSeed);
    await w.task(entrySeed);
    expect(await sqlState(() => w.task(offerSeed)), '同 Offer 两条签署中').toBe(UNIQUE_VIOLATION);
    expect(await sqlState(() => w.task(entrySeed)), '同入职两条签署中').toBe(UNIQUE_VIOLATION);
    expect(await sqlState(() => w.task({ ...offerSeed, status: 'completed' })), '终态不占唯一').toBe('ok');
    expect(await sqlState(() => w.task({ ...entrySeed, status: 'revoked' })), '终态不占唯一').toBe('ok');
  });
});
