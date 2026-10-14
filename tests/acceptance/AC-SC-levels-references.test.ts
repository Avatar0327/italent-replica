import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { levelReferenceWorld } from './AC-SC-levels-reference-support.js';

const testDb = useTestDb();
describe('AC-SC B2b P2-2 健康度的盘点字段引用', () => {
  it('AC-SC 引用阻止删除并保持字段与规则，清空规则后释放引用', async () => {
    const w = await levelReferenceWorld(testDb().db);
    const beforeField = await (await w.fieldRequest('GET')).json();
    const saved = await w.reference();
    expect(saved.status, await saved.clone().text()).toBe(201);
    const level = (await saved.json()) as { id: string; revision: number };
    const rejected = await w.fieldRequest('DELETE');
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { details: { reason: 'FIELD_IN_USE', referrer: 'SUCCESSION_HEALTH_LEVEL' } },
    });
    expect(await (await w.fieldRequest('GET')).json()).toEqual(beforeField);
    expect(await (await w.request('GET', `/health-levels/${level.id}`)).json()).toEqual(level);
    const cleared = await w.request('PUT', `/health-levels/${level.id}`, {
      ifMatch: level.revision,
      body: { rules: null },
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ rules: null, revision: level.revision + 1 });
    expect((await w.fieldRequest('DELETE')).status).toBe(200);
    expect((await w.fieldRequest('GET')).status).toBe(404);
  });
});
