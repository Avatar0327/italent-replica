import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { ESIGN, NOTICE, SCENES } from './AC-ESIGN-F505-s2-support.js';
import type { Receipt } from './AC-ESIGN-F505-s5-support.js';
import { s7World } from './AC-ESIGN-F505-S7-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
type Listed = { id: string; revision: number; status?: string; entryStatus?: number; employeeStatus?: number };
type Task = { id: string; revision: number; expiresAt: string; scene: string; status: string };

it.each(SCENES)('AC-ESIGN-F505-23 %s 真列表到签完、下载、撤销和过期后显式再发', async (scene) => {
  const w = await s7World(db().db, scene);
  const list = async () => (await json<{ items: Listed[] }>(await w.call('GET', w.listPath))).items;
  const before = (await list()).find(({ id }) => id === w.id);
  expect(before).toMatchObject(
    scene === 'offer'
      ? { status: 'accepted', rowActions: { menu: expect.arrayContaining(['sign']) } }
      : { employeeStatus: 1, entryStatus: 0 },
  );
  const contextPath = `${w.sourcePath}/esign-context`;
  const context = await json<{ revision: number; items: { id: string; name: string }[] }>(
    await w.call('GET', contextPath),
  );
  expect(context).toMatchObject({ canInitiate: true, revision: before!.revision });
  expect(context.items).toEqual([{ id: w.template.id, name: w.template.name }]);
  const body = { templateIds: context.items.map(({ id }) => id) };
  const start = (key: string) =>
    w
      .call('POST', `${w.sourcePath}/esign-tasks`, {
        ifMatch: context.revision,
        idempotencyKey: key,
        body,
      })
      .then((response) => json<Receipt>(response, 201));
  const mine = (id: string) => `${ESIGN}/mine/${id}`;
  const readTask = (id: string, user = w.initiator) => w.call('GET', mine(id), { user }).then((r) => json<Task>(r));
  const sign = ({ id, revision }: Task, user: string) =>
    w.call('POST', `${mine(id)}/sign`, { user, body: { revision } });
  const history = async () =>
    (await json<{ items: Task[] }>(await w.call('GET', `${w.sourcePath}/esign-records`))).items;

  const firstKey = uniqueSuffix();
  const first = await start(firstKey);
  expect(first.sourceId).toBe(before!.id);
  const awaitingEmployee = await readTask(first.taskId, w.employee);
  expect(awaitingEmployee).toMatchObject({ scene, status: 'signing', currentNode: 'employee', canSign: true });
  const awaitingEnterprise = await json<Task>(await sign(awaitingEmployee, w.employee));
  expect(awaitingEnterprise).toMatchObject({ status: 'signing', currentNode: 'enterprise' });
  const complete = await json<Task>(await sign(awaitingEnterprise, w.initiator));
  expect(complete).toMatchObject({ id: first.taskId, status: 'completed', currentNode: null });
  for (const [path, user] of [
    [`${mine(complete.id)}/files`, w.employee],
    [`${ESIGN}/records/files?ids=${complete.id}`, w.initiator],
  ] as const) {
    const download = await w.call('GET', path, { user });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/pdf');
    expect(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
  }
  const { items: notices } = await json<{ items: { businessId: string; body: string; sender: unknown }[] }>(
    await w.call('GET', NOTICE),
  );
  const label = scene === 'offer' ? 'Offer电子签署' : '入职电子签署';
  expect(notices).toContainEqual(
    expect.objectContaining({
      businessId: complete.id,
      sender: null,
      body: expect.stringContaining(`${label}任务（${complete.id}）已完成`),
    }),
  );
  expect(await start(firstKey)).toEqual(first);

  const cancelled = await start(uniqueSuffix());
  const ready = await readTask(cancelled.taskId);
  const revoked = await json(
    await w.call('POST', `${ESIGN}/records/revoke`, {
      body: { items: [{ id: ready.id, revision: ready.revision }] },
    }),
  );
  expect(revoked).toMatchObject({ items: [{ id: cancelled.taskId, ok: true }] });
  expect(await readTask(ready.id)).toMatchObject({ status: 'revoked' });

  const timed = await start(uniqueSuffix());
  const pending = await readTask(timed.taskId, w.employee);
  w.setNow(pending.expiresAt);
  await reason(await sign(pending, w.employee), 'ESIGN_TASK_EXPIRED');
  const replacement = await start(uniqueSuffix());
  expect(new Set([first.taskId, cancelled.taskId, timed.taskId, replacement.taskId]).size).toBe(4);
  expect(await history()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.taskId, scene, status: 'completed' }),
      expect.objectContaining({ id: cancelled.taskId, scene, status: 'revoked' }),
      expect.objectContaining({ id: timed.taskId, scene, status: 'expired' }),
      expect.objectContaining({ id: replacement.taskId, scene, status: 'signing' }),
    ]),
  );
  expect(await history()).toHaveLength(4);
  expect((await list()).find(({ id }) => id === w.id)).toEqual(before);
});
