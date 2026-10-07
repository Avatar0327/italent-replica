/** R5-P2-01 与第六轮结构性重写：新前驱结果自然传播，不能重放旧来源历史载荷差值。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { versions } from './AC-JOB-sequence-support.js';
import {
  ACTUAL_DATE,
  assertIdempotent,
  executeTransfers,
  manualCorrection,
  modeledFields,
  originalPayloads,
  propertySaveOrders,
  referenceTimeline,
  saveManagerChange,
  saveRename,
  saveTransfer,
  syncSequence,
  timelineWorld,
  type ModelEvent,
} from './AC-ORG-32-timeline-support.js';

const database = useTestDb();
const managerCases = [false, true].flatMap((explicit) =>
  [false, true].map((renameFirst) => ({ explicit, renameFirst })),
);

it.each(managerCases)(
  'AC-ORG-32 R5-P2-01 经理来源对照 / 显式=$explicit / 先F-007=$renameFirst',
  async ({ explicit, renameFirst }) => {
    const s = await timelineWorld(database().db, `r6manager${explicit}${renameFirst}`);
    const transfer = await saveTransfer(s);
    let renamedId: string;
    let managerId: string;
    if (renameFirst) {
      renamedId = await saveRename(s);
      managerId = await saveManagerChange(s, '2026-10-08', explicit);
    } else {
      managerId = await saveManagerChange(s, '2026-10-08', explicit);
      renamedId = await saveRename(s);
    }
    const originals = await originalPayloads(s);
    await executeTransfers(s, [transfer.id]);
    const records = await s.w.records(s.person.id, ACTUAL_DATE);
    expect(records.filter((r) => r.kind === 'org_adjustment').map((r) => r.id)).toEqual([managerId, renamedId]);
    for (const id of [managerId, renamedId])
      expect.soft(records.find((r) => r.id === id)?.fields, `组织调整 ${id}`).toMatchObject({
        positionId: s.positionA.id,
        directManagerId: explicit ? s.managerB.id : s.managerA.id,
        postId: s.postA.id,
        sequenceId: s.sequenceA.id,
        place: '原地点',
      });
    expect(records.find((r) => r.id === transfer.id)).toMatchObject({ effectiveDate: ACTUAL_DATE, isCurrent: true });
    expect(await originalPayloads(s)).toEqual(originals);
    await assertIdempotent(s);
  },
);

it.each(
  ['directManagerId', 'sequenceId'].flatMap((field) => [false, true].map((otherChange) => ({ field, otherChange }))),
)('AC-ORG-32 人工同值输入仍是显式意图 / $field / 另改备注=$otherChange', async ({ field, otherChange }) => {
  const s = await timelineWorld(database().db, `r6equal${field}${otherChange}`);
  const transfer = await saveTransfer(s);
  await saveManagerChange(s, '2026-10-08');
  const id = await saveRename(s);
  const record = await s.w.record(id, '2026-10-09');
  const value = field === 'directManagerId' ? s.managerB.id : s.sequenceB.id;
  expect(record.fields[field]).toBe(value);
  const response = await s.w.request('GET', `/businesses/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const { revision } = (await response.json()) as { revision: number };
  const corrected = await s.w.request('PATCH', `/records/${id}`, {
    ifMatch: revision,
    body: { fields: { [field]: value, ...(otherChange ? { remarks: '人工备注' } : {}) } },
  });
  expect(corrected.status, await corrected.clone().text()).toBe(200);
  await executeTransfers(s, [transfer.id]);
  expect((await s.w.record(id, '2026-10-09')).fields).toMatchObject({
    positionId: s.positionA.id,
    postId: s.postA.id,
    [field]: value,
    ...(otherChange ? { remarks: '人工备注' } : {}),
  });
  await assertIdempotent(s);
});

it.each([false, true])('AC-ORG-32 有效来源只使用曾传播的事件版本，历史更正不得逆灌 / 后续F-007=%s', async (chain) => {
  const s = await timelineWorld(database().db, `r6validPrefix${chain}`, true);
  const postC = await s.w.job('posts', '有效来源职务 C', { sequenceId: s.sequenceC.id });
  const sequenceY = await s.w.job('sequences', '历史更正 S_Y');
  const first = await s.w.business(
    s.person.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '迟到地点' } },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  await s.w.business(
    s.person.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-09',
      fields: { positionId: null, postId: s.postB.id },
    },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  if (chain) await saveRename(s);
  s.w.setNow('2026-10-06T01:00:00Z');
  const effectiveSource = await s.w.business(
    s.person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-06',
      fields: { positionId: null, postId: postC.id, sequenceId: s.sequenceX.id },
    },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  const targets = (await s.w.records(s.person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(targets).toHaveLength(chain ? 2 : 1);
  for (const target of targets) expect(target.fields).toMatchObject({ postId: postC.id, sequenceId: s.sequenceX.id });
  s.w.setNow('2026-10-11T01:00:00Z');
  const response = await s.w.request('GET', `/businesses/${effectiveSource.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const { revision } = (await response.json()) as { revision: number };
  const corrected = await s.w.request('PATCH', `/records/${effectiveSource.id}`, {
    ifMatch: revision,
    body: { fields: { sequenceId: sequenceY.id } },
  });
  expect(corrected.status, await corrected.clone().text()).toBe(200);
  expect((await s.w.record(effectiveSource.id, '2026-10-06')).fields.sequenceId).toBe(sequenceY.id);
  for (const target of targets)
    expect((await s.w.record(target.id, '2026-10-09')).fields.sequenceId).toBe(s.sequenceX.id);
  await executeTransfers(s, [first.id], '2026-10-12');
  for (const target of targets)
    expect((await s.w.record(target.id, '2026-10-09')).fields).toMatchObject({
      postId: postC.id,
      sequenceId: s.sequenceX.id,
    });
});

// 12 个固定种子保存排列 × 正/逆两种执行次序 = 24 组；一半使用同日 F-006/F-007（DEC-108）。
const propertyCases = propertySaveOrders().flatMap((saveOrder, index) =>
  [false, true].map((reverse) => ({
    saveOrder,
    name: saveOrder.join('→'),
    reverse,
    sameDay: index % 2 === 1,
    index,
  })),
);

it.each(propertyCases)(
  'AC-ORG-32 性质 / #$index $name / 逆执行=$reverse / 同日=$sameDay',
  async ({ saveOrder, reverse, sameDay, index }) => {
    const s = await timelineWorld(database().db, `r6property${index}${reverse}`);
    const first = await saveTransfer(s, false, false, true);
    const managerDate = sameDay ? '2026-10-09' : '2026-10-08';
    const events: ModelEvent[] = [{ id: first.id, kind: 'transfer1', date: ACTUAL_DATE, operation: 100 }];
    let secondId = '';
    let renamedId = '';
    let synced = false;
    for (const [operation, action] of saveOrder.entries()) {
      if (action === 'transfer2') {
        const second = await saveTransfer(s, true, synced, true);
        secondId = second.id;
        events.push({ id: second.id, kind: 'transfer2', date: ACTUAL_DATE, operation: 101 });
      } else if (action === 'F-006') {
        const id = await saveManagerChange(s, managerDate);
        events.push({ id, kind: action, date: managerDate, operation });
      } else if (action === 'F-007') {
        renamedId = await saveRename(s);
        events.push({ id: renamedId, kind: action, date: '2026-10-09', operation, manual: true });
      } else if (action === 'F-021') {
        await syncSequence(s);
        synced = true;
      } else {
        expect(renamedId, '合法保存排列应已创建更正对象').not.toBe('');
        await manualCorrection(s, renamedId);
      }
    }
    expect(secondId).not.toBe('');
    const originals = await originalPayloads(s);
    await executeTransfers(s, reverse ? [secondId, first.id] : [first.id, secondId]);
    const expected = referenceTimeline(s, events);
    const records = await s.w.records(s.person.id, ACTUAL_DATE);
    const actual = records
      .filter((r) => r.kind !== 'hire')
      .map((r) => ({
        id: r.id,
        date: r.effectiveDate,
        fields: modeledFields(r.fields),
      }));
    expect.soft(actual).toEqual(expected);
    const timeline = records.filter((r) => r.kind !== 'hire');
    for (const [position, record] of timeline.entries())
      expect.soft(record.previousRecordId).toBe(position === 0 ? s.person.recordId : timeline[position - 1]!.id);
    expect(records.find((r) => r.isCurrent)?.id).toBe(secondId);
    expect(await originalPayloads(s)).toEqual(originals);
    await assertIdempotent(s);
  },
);

it('AC-ORG-32 重建前人工更正 stale revision 拒绝且不追加载荷或修改时间轴', async () => {
  const s = await timelineWorld(database().db, 'r6negativeRevision');
  await saveTransfer(s);
  const id = await saveRename(s);
  const beforeRecords = await s.w.records(s.person.id, ACTUAL_DATE);
  const beforeVersions = await versions(s.db, s.w.tenant.id, s.person.id);
  const beforeEmployee = await s.w.getEmployee(s.person.id);
  const response = await s.w.request('GET', `/businesses/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const beforeBusiness = (await response.json()) as { revision: number };
  const rejected = await s.w.request('PATCH', `/records/${id}`, {
    ifMatch: beforeBusiness.revision - 1,
    body: { fields: { directManagerId: s.managerB.id } },
  });
  expect(rejected.status, await rejected.clone().text()).toBe(409);
  expect(await s.w.records(s.person.id, ACTUAL_DATE)).toEqual(beforeRecords);
  expect(await versions(s.db, s.w.tenant.id, s.person.id)).toEqual(beforeVersions);
  expect(await s.w.getEmployee(s.person.id)).toEqual(beforeEmployee);
  const afterResponse = await s.w.request('GET', `/businesses/${id}`);
  expect(afterResponse.status, await afterResponse.clone().text()).toBe(200);
  expect(await afterResponse.json()).toEqual(beforeBusiness);
});
