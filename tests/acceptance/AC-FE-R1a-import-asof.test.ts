import { resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';

const database = useTestDb();
const importing = () => import(resolve('apps/web/src/org/import-model.ts'));
const future = '2026-11-01';

// #342 第 3 轮 P2：导入行写入未来生效日时，冲突重读须按该行的写入时点取值，不能拿“今天”的值给用户核对。
it('AC-FE-R1a-43 导入行未来生效日版本冲突：重读按该行 startDate 读到他人在同一时点的修改与版本（真实接口）', async () => {
  const { orgRecordPath, rereadImportRows, withLatestRevisions } = await importing();
  const w = await orgPeopleWorld(database().db, 'fe-import-asof');
  const target = await w.org('合成部门');
  const other = await w.patchOrg(target, { name: '他人十一月改名', effectiveDate: future, addEmployment: false });
  expect(other.status, await other.clone().text()).toBe(200);
  const mine = {
    sourceCode: 'SRC-ASOF',
    orgId: target.id,
    code: target.code,
    name: '我的十一月名称',
    parentId: w.tenant.id,
    startDate: future,
    expectedRevision: target.revision,
    addEmployment: false,
  };
  const submit = (rows: unknown[]) => w.call('POST', 'org/import', { ifMatch: 0, body: { rows } });
  const conflict = await submit([mine]);
  expect(conflict.status).toBe(409);
  expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');

  const reads: (string | undefined)[] = [];
  const latest = await rereadImportRows([mine], async (orgId: string, asOf: string | undefined) => {
    reads.push(asOf);
    const response = await w.call('GET', orgRecordPath(orgId, asOf).replace('/api/tenant/', ''));
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  });
  // 核对区看到的是 11-01 时点他人的修改，而不是今天的名称。
  expect(latest).toEqual([
    expect.objectContaining({ sourceCode: 'SRC-ASOF', orgId: target.id, name: '他人十一月改名', expectedRevision: 2 }),
  ]);
  expect(reads).toEqual([future]);
  // 用户核对后显式重提：版本取重读值，内容是“我的输入”，写在同一时点。
  const resubmit = await submit(withLatestRevisions([mine], latest));
  expect(resubmit.status, await resubmit.clone().text()).toBe(200);
  expect((await w.orgsAt(future)).get(target.id)).toMatchObject({ name: '我的十一月名称' });
});
