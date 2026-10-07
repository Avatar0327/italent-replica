/** 第六轮：传播必须重新判断值匹配，旧事件的已接受字段不能成为永久依赖。 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { versions } from './AC-JOB-sequence-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();

it.each(['target-first', 'source-first'])(
  'AC-ORG-32 重算来源 before 后重新值匹配，目标显式输入不依赖保存顺序（%s）',
  async (order) => {
    const db = database().db;
    const w = await orgPeopleWorld(db, `r6forwardintent${order}`);
    const org = await w.org('重算传播部门');
    const a = await w.job('sequences', '入职 S_A');
    const b = await w.job('sequences', '迟到 S_B');
    const x = await w.job('sequences', '人工 S_X');
    const person = await w.hire('员工', { departmentId: org.id, sequenceId: a.id, place: '原地点' });
    const transfer = await w.business(
      person.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { sequenceId: b.id, place: '迟到地点' },
      },
      person.revision,
    );
    const create = async (date: string, fields: Record<string, string>) =>
      w.business(
        person.id,
        { kind: 'org_adjustment', mode: 'direct', effectiveDate: date, fields },
        (await w.getEmployee(person.id)).revision,
      );
    let targetId = '';
    if (order === 'target-first')
      targetId = (await create('2026-10-09', { sequenceId: b.id, remarks: '目标显式 S_B' })).id;
    const source = await create('2026-10-08', { remarks: '来源继承序列' });
    expect(source.record?.fields.sequenceId).toBe(b.id);
    const response = await w.request('GET', `/businesses/${source.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { revision } = (await response.json()) as { revision: number };
    const edited = await w.request('PATCH', `/records/${source.id}`, {
      ifMatch: revision,
      body: { fields: { sequenceId: x.id } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    if (order === 'source-first')
      targetId = (await create('2026-10-09', { sequenceId: b.id, remarks: '目标显式 S_B' })).id;
    // 旧时间轴确实接受了 B→X 的传播；另一保存顺序的目标仍显式为 B。
    expect((await w.record(targetId, '2026-10-09')).fields.sequenceId).toBe(order === 'target-first' ? x.id : b.id);
    const run = () =>
      runEmploymentActivations(db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date('2026-10-10T01:00:00Z') });
    expect((await run()).runs[0]).toMatchObject({ failed: [], errors: [] });
    const records = await w.records(person.id, '2026-10-10');
    expect(records.map((record) => record.id)).toEqual([person.recordId, source.id, targetId, transfer.id]);
    expect(records.find((record) => record.id === source.id)?.fields).toMatchObject({
      sequenceId: x.id,
      place: '原地点',
    });
    // 新来源的 before 是 A、after 是 X；目标显式 B 不再符合值匹配，按最终时间轴应为 B。
    expect(records.find((record) => record.id === targetId)?.fields).toMatchObject({
      sequenceId: b.id,
      place: '原地点',
    });
    expect(records.find((record) => record.isCurrent)).toMatchObject({
      id: transfer.id,
      effectiveDate: '2026-10-10',
      fields: { sequenceId: b.id, place: '迟到地点' },
    });
    const beforeRetry = await versions(db, w.tenant.id, person.id);
    expect((await run()).runs[0]).toMatchObject({ failed: [], errors: [] });
    expect(await versions(db, w.tenant.id, person.id)).toEqual(beforeRetry);
  },
);
