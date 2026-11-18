/**
 * F-326 S7b / DEC-941：变量列表与详情读视图带来源（设计 §5.5“列表多一列来源：人工 / 自动（流程名 · 节点名）”）。
 * 只改读视图：流程名、节点名按来源版本联接现有数据取，不加列、不加迁移。全部经真实 HTTP，合成数据。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { VARIABLES, variable } from './AC-APV-F326-S4-support.js';
import { create, firstAuto, s4World, specified } from './AC-APV-F326-S7a-support.js';

const database = useTestDb();
interface OriginView {
  id: string;
  revision: number;
  origin?: unknown;
  originProcessName?: unknown;
  originNodeName?: unknown;
}

describe('AC-APV-F326-39 变量读视图的来源（DEC-941）', () => {
  it('39-B1 列表：自动变量带来源流程名与节点名，人工变量 origin=manual、名称为空', async () => {
    const w = await s4World(database().db, 's7b-origin');
    const manual = await variable(w);
    const process = await create(w, [{ key: 'n1', name: '甲节点', approver: specified(w.near.userId) }]);
    const auto = await firstAuto(w, process.id);
    const page = await w.json<{ items: OriginView[] }>(
      await w.request(w.hr.id, 'GET', `${VARIABLES}?scope=public&status=active&limit=200&offset=0`),
    );
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(auto.id)).toMatchObject({
      origin: 'auto',
      originProcessName: '合成指定人员流程',
      originNodeName: '甲节点',
    });
    expect(byId.get(manual.id)).toMatchObject({ origin: 'manual', originProcessName: null, originNodeName: null });
  });

  it('39-B2 详情与写回执同形：自动变量改名后回执仍带来源', async () => {
    const w = await s4World(database().db, 's7b-origin-detail');
    const process = await create(w, [{ key: 'n1', name: '甲节点', approver: specified(w.near.userId) }]);
    const auto = await firstAuto(w, process.id);
    const detail = await w.json<OriginView>(await w.request(w.hr.id, 'GET', `${VARIABLES}/${auto.id}`));
    expect(detail).toMatchObject({ origin: 'auto', originProcessName: '合成指定人员流程', originNodeName: '甲节点' });
    const renamed = await w.json<OriginView>(
      await w.request(w.hr.id, 'PATCH', `${VARIABLES}/${auto.id}`, {
        ifMatch: detail.revision,
        body: { name: '合成改名' },
      }),
    );
    expect(renamed).toMatchObject({ origin: 'auto', originProcessName: '合成指定人员流程', originNodeName: '甲节点' });
  });
});
