/** F-192b 前端接线前的真实接口门禁；不往浏览器夹具补造服务端没有的取消说明字段。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { addPending, entryAction, entryActionRows, entryWorld } from './AC-EN-BE2a-support.js';

const testDb = useTestDb();

it('AC-FE-F192b-03 取消后重读已取消列表应能取得已保存的备注', async () => {
  const w = await entryWorld(testDb().db, 'f192b-cancel-remark');
  const { recordId } = await addPending(w);
  const remark = '合成取消说明：候选人调整入职安排';
  const cancelled = await entryAction(w, recordId, 'cancel', { reason: 'personal', remark });
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  expect(await entryActionRows(w)).toMatchObject([{ businessId: recordId, action: 'cancel', remark }]);

  const response = await w.session.request('GET', '/pending-entries?view=cancelled');
  expect(response.status).toBe(200);
  const result = (await response.json()) as { items: Record<string, unknown>[] };
  const row = result.items.find((item) => item.id === recordId);
  expect(row).toMatchObject({ entryStatus: 1, effectiveDate: '2026-10-10' });
  // TODO(需取证 #376)：字段名与权限契约待后端明确；这里只要求备注可读，不猜响应字段名。
  expect(JSON.stringify(row), '已取消列表遗漏已持久化的取消说明，前端重读无法展示').toContain(remark);
});

it('AC-FE-F192b-05 取消后可通过改期恢复到全部待入职且状态为延期', async () => {
  const w = await entryWorld(testDb().db, 'f192b-restore');
  const { recordId } = await addPending(w);
  expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(200);
  const restored = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-09-20' });
  expect(restored.status, await restored.clone().text()).toBe(200);
  const { id } = (await restored.json()) as { id: string };
  expect(id).not.toBe(recordId);
  const cancelled = await w.session.request('GET', '/pending-entries?view=cancelled');
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ items: [] });
  const all = await w.session.request('GET', '/pending-entries?view=all');
  expect(all.status).toBe(200);
  expect(await all.json()).toMatchObject({ items: [{ id, entryStatus: 2, effectiveDate: '2026-09-20' }] });
});
