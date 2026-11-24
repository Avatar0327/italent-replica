import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { entryAction } from './AC-EN-BE2a-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import {
  BASE,
  EMPLOYMENT_OBJECT,
  ESIGN,
  RECORD_OBJECT,
  resultPath,
  s5World,
  source,
  type Receipt,
} from './AC-ESIGN-F505-s5-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
type Context = { sourceId: string; revision: number; canInitiate: boolean; items: { id: string; name: string }[] };

it('AC-ESIGN-F505-FE-02/04 裁剪列表字段时以原来源上下文为准，换 ID 后原键回查不能迁移', async () => {
  const w = await s5World(db().db);
  const entry = await w.pending();
  const template = await w.template();
  const grants = { fields: { [EMPLOYMENT_OBJECT]: ['id'] } };
  const readList = () =>
    w
      .restricted(grants)('GET', `${BASE}?view=all`)
      .then((r) => json<{ items: { id: string }[] }>(r));
  const list = await readList();
  expect(list.items).toHaveLength(1);
  const row = list.items[0]!;
  expect(row.id).toBe(entry.id);
  for (const field of ['revision', 'kind', 'employeeStatus', 'entryStatus', 'employeeId'])
    expect(row).not.toHaveProperty(field);
  const getContext = (id: string) => w.restricted(grants)('GET', source(id, 'context'));
  const context = await json<Context>(await getContext(row.id));
  expect(context).toEqual({
    sourceId: entry.id,
    revision: entry.revision,
    canInitiate: true,
    items: [{ id: template.id, name: template.name }],
  });
  const key = uniqueSuffix();
  const receipt = await json<Receipt>(
    await w.submit({ id: row.id, revision: context.revision }, [template.id], key),
    201,
  );
  expect(await json(await w.call('GET', resultPath(key)))).toEqual(receipt);

  const replaced = await json<{ id: string }>(
    await entryAction(w, row.id, 'postpone', { effectiveDate: '2026-12-20' }, context.revision),
  );
  expect(replaced.id).not.toBe(row.id);
  await w.error(await getContext(row.id), 404);
  await w.error(await w.call('GET', resultPath(key)), 404);
  expect((await readList()).items.map(({ id }) => id)).toEqual([replaced.id]);
  expect(await json(await w.call('GET', source(replaced.id, 'records')))).toMatchObject({ items: [], total: 0 });
  expect(await json(await w.call('GET', `${ESIGN}/mine/${receipt.taskId}`))).toMatchObject({
    id: receipt.taskId,
    status: 'revoked',
    scene: 'entry',
  });
});

it('AC-ESIGN-F505-FE-03/05 已取消来源可独立读历史，状态和文件字段裁剪，撤记录权拒绝读取', async () => {
  const w = await s5World(db().db);
  const entry = await w.pending();
  const template = await w.template();
  const { taskId } = await json<Receipt>(await w.submit(entry, [template.id]), 201);
  await json(await entryAction(w, entry.id, 'cancel', {}, entry.revision));
  const path = source(entry.id, 'records');
  const readOnly = {
    deny: ({ action }: { action: string }) => action === 'object.update' || action === 'object.button',
  };
  await w.error(await w.restricted(readOnly)('GET', source(entry.id, 'context')), 403);
  expect(await json(await w.restricted(readOnly)('GET', path))).toMatchObject({
    items: [{ id: taskId, scene: 'entry', status: 'revoked', files: [{ name: template.name }] }],
  });
  const masked = await w.restricted({ ...readOnly, fields: { [RECORD_OBJECT]: ['scene'] } })('GET', path);
  expect(await json(masked)).toEqual({
    items: [{ id: taskId, revision: 2, scene: 'entry' }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  await w.error(await w.restricted({ deny: ({ resource }) => resource === RECORD_OBJECT })('GET', path), 403);
});
