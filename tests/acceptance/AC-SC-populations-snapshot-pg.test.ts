/** AC-SC B2a：真 PG 提交交错，所有 HTTP 出口不得拼接跨版本规则。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { configBody, configWorld } from './AC-SC-config-support.js';
import { resultRows } from './AC-ORG-people-support.js';
const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC 人员范围响应快照', () => {
  let w: Awaited<ReturnType<typeof configWorld>>;
  beforeAll(async () => {
    w = await configWorld(testDb().db);
  });
  it.each(['列表', '详情', 'POST 首次', 'PUT 首次', 'POST 重放', 'PUT 重放', 'POST 回查', 'PUT 回查'])(
    '%s：读取头部后另一事务保存，响应仍为完整已提交版本',
    async (mode) => {
      const saved = await w.create();
      const method = mode.startsWith('POST') ? 'POST' : mode.startsWith('PUT') ? 'PUT' : 'GET';
      const body = { ...configBody(), name: '读取快照' };
      const options = { body, ifMatch: method === 'POST' ? 0 : 1, idempotencyKey: randomUUID() };
      const path = mode === '列表' || method === 'POST' ? '/populations' : `/populations/${saved.id}`;
      if (mode.includes('重放'))
        expect((await w.request(method, path, options)).status).toBe(method === 'POST' ? 201 : 200);
      const transaction = w.db.transaction.bind(w.db);
      let changed = false,
        lost = false,
        reads = 0;
      const skip = mode.includes('重放') || mode.includes('回查') ? 1 : 0;
      const spy = vi.spyOn(w.db, 'transaction').mockImplementation(async (callback, config) => {
        const result = await transaction(async (tx) => {
          const execute = tx.execute.bind(tx);
          let locked = false;
          tx.execute = (async (...args: Parameters<typeof tx.execute>) => {
            const result = await execute(...args);
            const rows = resultRows<{ id: string; code: string; expression: string; revision: number; kind: string }>(
              result,
            );
            if (rows.some((row) => row.kind === 'org_health')) locked = true;
            const parent = rows.find(
              (row) => row.code === (method === 'GET' ? saved.code : body.code) && typeof row.expression === 'string',
            );
            if (!locked && parent && !changed && reads++ >= skip) {
              changed = true;
              const rules = { expression: '2', rows: [{ ...configBody().rules.rows[0]!, rowNo: 2, values: [50] }] };
              const update = await w.request('PUT', `/populations/${parent.id}`, {
                ifMatch: parent.revision,
                body: { rules },
              });
              expect(update.status, await update.clone().text()).toBe(200);
            }
            return result;
          }) as typeof tx.execute;
          return callback(tx);
        }, config);
        // 提交已成功但确认丢失：真实命令执行器必须进入失败回查，而非直接重放。
        if (mode.includes('回查') && !lost && result && typeof result === 'object' && 'status' in result) {
          lost = true;
          throw new Error('合成提交确认丢失');
        }
        return result;
      });
      try {
        const response = await w.request(method, path, method === 'GET' ? {} : options);
        expect(response.status, await response.clone().text()).toBe(method === 'POST' ? 201 : 200);
        const data = await response.json();
        const view = mode === '列表' ? data.items.find((item: { id: string }) => item.id === saved.id) : data;
        expect(changed).toBe(true);
        expect(lost).toBe(mode.includes('回查'));
        expect(view.rules).toEqual(method === 'GET' ? saved.rules : body.rules);
        if (mode !== '列表') expect(response.headers.get('etag')).toBe(`"${view.revision}"`);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
