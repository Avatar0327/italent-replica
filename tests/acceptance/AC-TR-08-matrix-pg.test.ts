/**
 * AC-TR-08-matrix-pg · R3-T04 PR-B4 位置字段占用的真 PostgreSQL 并发（设计 §2.2 D-20；AC-TR-08）：
 * 唯一 (tenant_id, field_id) 覆盖 before-before、after-after、两向 before-after；两个事务同时占用同一个字段，
 * 恰好一个成功，另一个 409 MATRIX_POSITION_FIELD_IN_USE，库里只留成功的那一个九宫格（整体回滚，没有半个九宫格）。
 * 同一九宫格同一 revision 的并发修改也只有一个成功。PGlite 单连接无法并发，仅在设置 TEST_DATABASE_URL 时运行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('九宫格位置字段占用 · PostgreSQL 16 并发', () => {
  it.each([
    ['before-before', 'before', 'before'],
    ['after-after', 'after', 'after'],
    ['交叉 before-after', 'before', 'after'],
    ['交叉 after-before', 'after', 'before'],
  ] as const)('两个九宫格同时占用同一位置字段 · %s：一成一败，库里只有一个', async (_name, aRole, bRole) => {
    const w = await matrixWorld(testDb().db, `trm-pg-${aRole}-${bRole}`);
    const shared = (await w.positionField()).id;
    const build = async (role: 'before' | 'after') => {
      const refs = await w.refs();
      return matrixBody(role === 'before' ? { ...refs, before: shared } : { ...refs, after: shared });
    };
    const [a, b] = await Promise.all([build(aRole), build(bRole)]);
    const responses = await Promise.all([w.post(a), w.post(b)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await reasonOf(loser)).toBe('MATRIX_POSITION_FIELD_IN_USE');
    const items = (await w.list()).items;
    expect(items).toHaveLength(1);
    const claimed = items[0]!.positionFields.map((row) => row.fieldId);
    expect(claimed).toContain(shared);
    expect(items[0]!.cells).toHaveLength(9);
  });

  it('同一九宫格同一 revision 并发修改：一个 200，一个 409，revision 只加 1', async () => {
    const w = await matrixWorld(testDb().db, 'trm-pg-revision');
    const created = await w.create();
    const patch = (name: string) => w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { name } });
    const responses = await Promise.all([patch('甲'), patch('乙')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const now = (await w.read(created.id)).body as MatrixView;
    expect(now.revision).toBe(2);
  });

  it('同时把同一个新字段挪给两个不同的九宫格：恰好一个成功', async () => {
    const w = await matrixWorld(testDb().db, 'trm-pg-move');
    const a = await w.create();
    const b = await w.create();
    const shared = (await w.positionField()).id;
    const move = (matrix: MatrixView) =>
      w.request('PATCH', `${MATRICES}/${matrix.id}`, {
        ifMatch: 1,
        body: {
          positionFields: [
            { role: 'before', fieldId: shared },
            { role: 'after', fieldId: matrix.positionFields.find((row) => row.role === 'after')!.fieldId },
          ],
        },
      });
    const responses = await Promise.all([move(a), move(b)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const all = (await w.list()).items;
    expect(all.filter((item) => item.positionFields.some((row) => row.fieldId === shared))).toHaveLength(1);
  });
});
