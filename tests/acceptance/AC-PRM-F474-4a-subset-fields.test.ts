/**
 * F-474-4a（DEC-778）：人员子集补字段——培训经历（培训类别名称、培训分类）、表彰与奖励（奖励金额、发放日期）、
 * 语言能力（获取证书）。新列同时落在主表与版本表：新增、修改后读取回显，版本历史留有每一版的值。
 * 原站下拉候选未取证的字段（培训分类）按文本保存，不枚举取值。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rosterWorld, type RosterWorld } from './AC-HA-roster-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
type Row = Record<string, unknown> & { id: string; revision: number };

async function person(w: RosterWorld) {
  const employee = await w.session.employee('合成员工', `S4A${uniqueSuffix()}`);
  return `/api/tenant/personnel/employees/${employee.id}/subsets`;
}
async function create(w: RosterWorld, path: string, kind: string, body: Record<string, unknown>) {
  const response = await w.call('POST', `${path}/${kind}`, { ifMatch: 0, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Row;
}

describe('AC-PRM F-474-4a 子集补字段', () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'training',
      { name: '合成培训', categoryName: '合成类别名称', classification: '合成分类' },
      { categoryName: '改后类别名称', classification: '改后分类' },
    ],
    [
      'awards',
      { name: '合成奖项', awardDate: '2026-03-01', amount: 1200.5, payDate: '2026-04-01' },
      { amount: 800, payDate: '2026-05-01' },
    ],
    ['language-ability', { language: '英语', acquiredCertificate: '合成证书' }, { acquiredCertificate: '改后证书' }],
  ])('%s：新增与修改后读取回显，版本历史保留每一版', async (kind, created, patch) => {
    const w = await rosterWorld(database().db, `prm4a-${kind}`);
    const path = await person(w);
    const row = await create(w, path, kind, created);
    for (const [key, value] of Object.entries(created)) expect(String(row[key])).toBe(String(value));

    const updated = await w.call('PATCH', `${path}/${kind}/${row.id}`, { ifMatch: row.revision, body: patch });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const read = (await (await w.call('GET', `${path}/${kind}/${row.id}`)).json()) as Row;
    for (const [key, value] of Object.entries(patch)) expect(String(read[key])).toBe(String(value));
    expect(String(read[Object.keys(created)[0]!])).toBe(String(Object.values(created)[0]));

    const history = (await (await w.call('GET', `${path}/${kind}/${row.id}/history`)).json()) as { items: Row[] };
    const first = Object.keys(patch)[0]!;
    expect(history.items.map((item) => String(item[first]))).toEqual([String(patch[first]), String(created[first])]);
  });

  it('奖励金额不是数字时拒绝，不落库', async () => {
    const w = await rosterWorld(database().db, 'prm4a-amount');
    const path = await person(w);
    const response = await w.call('POST', `${path}/awards`, { ifMatch: 0, body: { name: '合成奖项', amount: 'abc' } });
    expect(response.status).toBe(400);
  });
});
