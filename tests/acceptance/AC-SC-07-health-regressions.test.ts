import { compilePopulation, evaluateFormula, inMemorySubject } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { healthPeople } from '../../apps/api/src/modules/succession/health-population.js';

const db = useHealthDb();
describe('AC-SC-07 第 1 轮计算正确性回归', () => {
  it('P2-1：仅编辑任职备注，入职日期与自定义人群成员保持不变', async () => {
    const w = await successionWorld(db().db, 'health-entry-regression'),
      org = await w.org('入职日期人群'),
      position = await w.position(org.id, '人群职位'),
      person = await w.hire('合成人群成员', { departmentId: org.id, positionId: position.id });
    const read = () => w.asTenant((tx) => healthPeople(tx, w.tenant.id, org.id, SC_TODAY));
    const before = await read();
    const compiled = compilePopulation({
      expression: '1',
      rows: [
        {
          rowNo: 1,
          kind: 'field',
          field: {
            object: 'employee',
            code: 'entry_date',
            path: 'employee.entry_date',
            kind: 'date',
          },
          operator: 'eq',
          values: [SC_TODAY],
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('人群编译失败');
    const member = (p: (typeof before)[number]) =>
      evaluateFormula(compiled.compiled.formula, {
        calendar: { today: SC_TODAY, timeZone: 'Asia/Shanghai' },
        subject: inMemorySubject(p.id, p.fields),
        fieldKind: () => 'date',
      });
    expect(member(before[0]!)).toMatchObject({ ok: true, value: { kind: 'number', value: 1 } });
    const record = await (await w.call('GET', `employment/records/${person.recordId}?asOf=${SC_TODAY}`)).json();
    const changed = await w.call('PATCH', `employment/records/${person.recordId}`, {
      ifMatch: record.revision,
      body: { fields: { remarks: '合成备注修改' } },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const current = await (await w.call('GET', `employment/records/${person.recordId}?asOf=${SC_TODAY}`)).json();
    expect(current.entryDate).toBe(SC_TODAY);
    const after = await read();
    expect(after[0]!.fields['employee.entry_date']).toBe(current.entryDate);
    expect(after).toEqual(before);
    expect(member(after[0]!)).toMatchObject({ ok: true, value: { kind: 'number', value: 1 } });
    expect(after[0]!.fields['employment.position_id']).toBe(position.id);
  });
});
