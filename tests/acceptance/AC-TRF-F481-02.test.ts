/**
 * AC-TRF-F481-02 调动表单下拉（设计 §3.2、§4.3、§10.2）：只出启用模板的 id / name，按 sort_order、name 排序，
 * 不按场景过滤；授权与 POST /transfers/employees/:id 同一（Transfer.Hr 按钮），不要求模板维护权。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denySettings, denyTransferHr, esignWorld } from './AC-TRF-F481-support.js';

const db = useTestDb();
const PATH = '/template-options/transfer-form';

describe('AC-TRF-F481-02 调动表单模板下拉', () => {
  it('只出启用模板、按顺序、只含 id 与 name；停用的不出现，任意名称都出（不按场景过滤）', async () => {
    const w = await esignWorld(db().db, 'opt');
    const second = await w.create('second', { sortOrder: 20, name: 'ZZ_F481_入职信息登记表模板' });
    const first = await w.create('first', { sortOrder: 10, name: 'ZZ_F481_调动协议模板' });
    const off = await w.create('off', { sortOrder: 5 });
    await w.call('PATCH', `/templates/${off.id}`, { ifMatch: off.revision, body: { status: 'disabled' } });
    const response = await w.call('GET', PATH);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ]);
  });

  it('没有 Transfer.Hr 按钮 403；有该按钮但没有模板维护权也 200', async () => {
    const hr = await esignWorld(db().db, 'opt-hr');
    await hr.create('a');
    const noHr = await esignWorld(db().db, 'opt-nohr', denyTransferHr);
    expect((await noHr.call('GET', PATH)).status).toBe(403);
    const noSettings = await esignWorld(db().db, 'opt-nosettings', denySettings);
    expect((await noSettings.call('GET', PATH)).status).toBe(200);
  });

  it('另一租户的模板不出现；没有模板时返回空列表', async () => {
    const a = await esignWorld(db().db, 'opt-a');
    const b = await esignWorld(db().db, 'opt-b');
    await a.create('mine');
    const empty = await b.call('GET', PATH);
    expect(await empty.json()).toEqual({ items: [] });
  });
});
