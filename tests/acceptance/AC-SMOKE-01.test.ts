/**
 * AC-SMOKE-01（M0 骨架冒烟，非业务 AC）：演示验收测试写法。
 * 约定：文件名 = AC 编号；每个文件用 useTestDb() 拿一个跑完迁移的全新库；
 * 通过 createApp(deps).request() 走完整 HTTP 链路，不起端口。
 * 断言对象是规格里的可观察结果（状态码、机器可读错误码、落库数据），不断言中文文案。
 */
import { createApp, type ErrorBody } from '@italent/api';
import { platformMeta } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();

describe('AC-SMOKE-01 骨架链路：迁移 → 数据库 → API', () => {
  it('迁移后的库可写入，健康检查经数据库探测返回 ok', async () => {
    const { db } = testDb();
    await db.insert(platformMeta).values({ key: 'smoke', value: 'AC-SMOKE-01' });

    const res = await createApp({ db }).request('/healthz');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('未知接口返回机器可读错误码', async () => {
    const res = await createApp({ db: testDb().db }).request('/v1/unknown');

    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});
