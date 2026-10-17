/**
 * BE-14a 第 3 轮审查 P2-03（#394，DEC-455）真 PG 交错：校招生提前实习 / 复制的源 Offer 只读一次。
 * 判定（CommandGuard.before 按展开后的字段校验编辑权）之后、落库之前，另一会话改源 Offer 填入请求人无权编辑的手机号；
 * 请求人的结果要么 403，要么保存的新 Offer 不含该手机号——Offer 条数、成功审计与台账与之一致。
 * 屏障放在事务内的字段编辑权判定上（展开后的载荷带出 name，事务外预判的请求载荷不带），授权判定与两次写入都走实际实现。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as access from '../../apps/api/src/modules/permission/module-route-access.js';
import { offerRealWorld, type OfferBody } from './AC-OF-BE14a-support.js';
import { settledOrBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const MOBILE = '13900000000';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 在事务内按展开后的字段判编辑权时暂停一次（字段里带出 name 才是展开后的载荷）。 */
function pauseExpandedCheck() {
  const entered = barrier(),
    resume = barrier();
  const original = access.writeFields;
  let paused = false;
  vi.spyOn(access, 'writeFields').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!paused && 'name' in (args[4] as object)) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return result;
  });
  return { entered, resume };
}

async function arrived(pause: ReturnType<typeof pauseExpandedCheck>, request: Promise<Response>) {
  await Promise.race([
    pause.entered.promise,
    request.then(async (response) => {
      throw new Error(`请求未到判定边界即结束：${response.status} ${await response.clone().text()}`);
    }),
  ]);
}

type World = Awaited<ReturnType<typeof offerRealWorld>>;

/** A 的结果与数据库一致：403 则无新增、无成功审计与台账；201 则新 Offer 不含手机号，审计 + 台账各一条。 */
async function expectNoUnauthorizedMobile(w: World, response: Response, before: number, key: string) {
  const text = await response.clone().text();
  expect([201, 403], text).toContain(response.status);
  if (response.status === 403) {
    expect(await w.count()).toBe(before);
    expect(await w.traces(key)).toBe(0);
    return;
  }
  const created = (await response.json()) as OfferBody;
  expect(created.mobile ?? null).toBeNull();
  expect(await w.count()).toBe(before + 1);
  expect(await w.traces(key)).toBe(2);
  const [row] = (await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT mobile, revision FROM offers WHERE id = ${created.id}`),
  ).then((result) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows))) as {
    mobile: string | null;
    revision: number;
  }[];
  expect(row).toMatchObject({ mobile: null, revision: 1 });
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('P2-03 源 Offer 判定后被改不带入无权字段（真 PG）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('校招生提前实习：判定后另一用户经 HTTP 给待发校招 Offer 填手机号，A 不保存该手机号', async () => {
    const w = await offerRealWorld(testDb().db, 'race-campus', ['mobile']);
    const campus = await w.social({ offerType: 'campus' });
    expect(campus).toMatchObject({ mobile: null, revision: 1 });
    const { name: _n, personalEmail: _e, ...rest } = w.internFields();
    const before = await w.count();
    const key = randomUUID();
    const pause = pauseExpandedCheck();
    const pending = w.real('POST', '', {
      ifMatch: 0,
      idempotencyKey: key,
      body: { entry: 'campus_early_intern', campusOfferId: campus.id, ...rest },
    });
    let edit: Promise<Response> | undefined;
    try {
      await arrived(pause, pending);
      edit = w.request('PUT', `/${campus.id}`, { ifMatch: 1, body: { mobile: MOBILE } });
      await settledOrBlocked(w.db, edit, 1);
    } finally {
      pause.resume.resolve();
    }
    const response = await pending;
    const edited = await edit!;
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ mobile: MOBILE, revision: 2 });
    await expectNoUnauthorizedMobile(w, response, before, key);
  });

  it('复制：判定后另一会话给失效源 Offer 写入手机号（可信 SQL，失效 Offer 无编辑入口），A 不保存该手机号', async () => {
    const w = await offerRealWorld(testDb().db, 'race-copy', ['mobile']);
    const source = await w.intern();
    await w.invalidated(source.id);
    const before = await w.count();
    const key = randomUUID();
    const pause = pauseExpandedCheck();
    const pending = w.real('POST', `/${source.id}/copy`, { ifMatch: 1, idempotencyKey: key });
    let write: Promise<unknown> | undefined;
    try {
      await arrived(pause, pending);
      write = withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE offers SET mobile = ${MOBILE} WHERE id = ${source.id}`),
      );
      await settledOrBlocked(w.db, write, 1);
    } finally {
      pause.resume.resolve();
    }
    const response = await pending;
    await write;
    await expectNoUnauthorizedMobile(w, response, before, key);
  });
});
