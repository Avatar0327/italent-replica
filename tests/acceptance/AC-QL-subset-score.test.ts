/**
 * R3-T02 C1-3b：任职资格子集 finalScore 的精度口径（DEC-374⑤ 🟡 待取证原站超精度行为；规格 23 §10 “小数 2 位”）：
 * 超过两位小数一律 400（reason FIELD_PRECISION，提示“最多两位小数”），HR 直写、信息采集和系统来源（评定发布等）同一处拦截；
 * 合法值原样保存，读取、写入回执和版本表一致（不舍入）；与旧值相等的原样带回不重新校验。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { saveSubset } from '../../apps/api/src/modules/personnel/subsets.js';
import { subsetScene } from './AC-QL-subset-support.js';

const database = useTestDb();

const bodyOf = async (response: Response) =>
  (await response.clone().json()) as { error?: { code?: string; message?: string; details?: { reason?: string } } };

describe('AC-QL-subset-score finalScore 最多两位小数（DEC-374⑤ 🟡）', () => {
  it('合法值原样保存：88.55 / 88.5 / 88 / 0；读取、回执与版本表一致', async () => {
    const { w, path, add, rows, tx } = await subsetScene(database, 'qs-score-ok');
    for (const value of [88.55, 88.5, 88, 0]) {
      const response = await add({ finalScore: value });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(((await response.json()) as { finalScore: number }).finalScore).toBe(value);
    }
    expect((await rows()).map((row) => Number(row.final_score)).sort()).toEqual([0, 88, 88.5, 88.55]);
    const listed = await w.json<{ items: { finalScore: number }[] }>(await w.request(w.hr.id, 'GET', path));
    expect(listed.items.map((item) => item.finalScore).sort()).toEqual([0, 88, 88.5, 88.55]);
    const versions = await tx(async (t) => {
      const result = await t.execute(
        sql`SELECT final_score FROM personnel_qualification_versions ORDER BY created_at, id`,
      );
      return (Array.isArray(result) ? result : (result as { rows: { final_score: string }[] }).rows).map((r) =>
        Number((r as { final_score: string }).final_score),
      );
    });
    expect(versions.sort()).toEqual([0, 88, 88.5, 88.55]);
  });

  it('新增超过两位小数 → 400 FIELD_PRECISION，不留行不留版本', async () => {
    const { add, rows, count } = await subsetScene(database, 'qs-score-create');
    for (const value of [88.555, 77.777, 0.001, 1e-7, 12.345678]) {
      const response = await add({ finalScore: value });
      expect(response.status, `${value}`).toBe(400);
      const body = await bodyOf(response);
      expect(body.error?.code).toBe('VALIDATION_FAILED');
      expect(body.error?.details?.reason).toBe('FIELD_PRECISION');
      expect(body.error?.message).toContain('最多两位小数');
    }
    expect(await rows()).toEqual([]);
    expect(await count(sql`SELECT count(*)::int AS n FROM personnel_qualification_versions`)).toBe(0);
  });

  it('修改成超过两位小数 → 400，原值与版本不变；原样带回已有的合法值、改别的字段不受影响', async () => {
    const { w, path, add, rows, count } = await subsetScene(database, 'qs-score-patch');
    const created = (await (await add({ finalScore: 88.55 })).json()) as { id: string };
    const patch = (body: Record<string, unknown>, revision: number) =>
      w.request(w.hr.id, 'PATCH', `${path}/${created.id}`, { ifMatch: revision, body });
    const bad = await patch({ finalScore: 77.777 }, 1);
    expect(bad.status).toBe(400);
    expect((await bodyOf(bad)).error?.details?.reason).toBe('FIELD_PRECISION');
    expect(Number((await rows())[0]!.final_score)).toBe(88.55);
    expect(await count(sql`SELECT count(*)::int AS n FROM personnel_qualification_versions`)).toBe(1);

    const same = await patch({ finalScore: 88.55, endDate: '2027-01-01' }, 1);
    expect(same.status, await same.clone().text()).toBe(200);
    const other = await patch({ endDate: '2027-06-30' }, 2);
    expect(other.status).toBe(200);
    const cleared = await patch({ finalScore: null }, 3);
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect((await rows())[0]!.final_score).toBeNull();
  });

  it('系统来源（评定发布等）超过两位小数同样拒绝，不能绕过 HTTP 限制', async () => {
    const { w, s, tx, base, rows } = await subsetScene(database, 'qs-score-system');
    const save = (finalScore: number) =>
      tx((t) =>
        saveSubset(
          t,
          {
            tenantId: w.tenant.id,
            userId: w.hr.id,
            timezone: 'Asia/Shanghai',
            now: w.clock(),
            commandId: randomUUID(),
            expectedRevision: 0,
          },
          s.subject.employeeId,
          'qualification',
          base({ finalScore, evaluationId: randomUUID() }),
          undefined,
          false,
          { type: 'evaluation', id: randomUUID() },
        ),
      );
    await expect(save(90.123)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'FIELD_PRECISION' },
    });
    expect(await rows()).toEqual([]);
    expect(await save(90.12)).toMatchObject({ finalScore: 90.12 });
  });
});
