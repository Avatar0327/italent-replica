/** S7d：引用计数与 §6.1 同口径，跨节点、版本去重，只有数字可披露。 */
import { APPROVAL_PROCESS_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ProcessView } from './AC-APV-support.js';
import {
  APPROVAL,
  autoAt,
  autoViewOf,
  create,
  dispatch,
  draftOk,
  manager,
  newVersion,
  publicVar,
  readProcess,
  s4World,
  specified,
} from './AC-APV-F326-S7a-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();
const count = (p: ProcessView) =>
  (autoViewOf(p.latestVersion.nodes[0]!.approver) as { referencingProcessCount?: number } | undefined)
    ?.referencingProcessCount;

describe('AC-APV-F326-49 引用流程数', () => {
  it('① 草稿为 1；② 当前 / 草稿 / 在途旧版本为 3；③ 多节点不多计；④ 去引用为 2；⑤ 查看者只得数字', async () => {
    const w = await s4World(database().db, 's7d-count');
    const aNode = { key: 'a1', approver: specified(w.near.userId) };
    const a0 = await create(w, [aNode], { approvalType: 'personnel_change' });
    const a = await draftOk(w, a0, [aNode]);
    expect(count(a)).toBe(1);
    const published = await w.publish(a);
    const v = await autoAt(w, a.id, 'a1');
    const b = await w.publish(await create(w, [{ key: 'b1', approver: publicVar(v.id) }], { name: '隐藏乙流程' }));
    await dispatch(w);
    const b2 = await newVersion(w, b);
    await w.publish(b2);
    const c = await create(w, [{ key: 'c1', approver: publicVar(v.id) }], { name: '隐藏丙流程' });
    const draft = await draftOk(w, await newVersion(w, published), [aNode, { key: 'a2', approver: publicVar(v.id) }]);
    expect(count(draft)).toBe(3);
    await draftOk(w, c, [{ key: 'c1', approver: manager }]);
    expect(count(await readProcess(w, a.id))).toBe(2);
    const viewer = await w.member('合成仅查看者');
    const api = tenantApi(w.db, {
      clock: w.clock,
      authorize: (q) => q.userId === viewer && q.action === 'object.view' && q.resource === APPROVAL_PROCESS_OBJECT,
    });
    const response = await api.request('GET', `${APPROVAL}/processes/${a.id}`, w.as(viewer));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ProcessView;
    expect(count(view)).toBe(2);
    for (const value of ['隐藏乙流程', '隐藏丙流程', b.code, c.code]) expect(JSON.stringify(view)).not.toContain(value);
    // 去掉 B 当前版本引用，旧版本仍有在途实例，计数仍为 2。
    const b3 = await draftOk(w, await newVersion(w, b2), [{ key: 'b1', approver: manager }]);
    await w.publish(b3);
    expect(count(await readProcess(w, a.id))).toBe(2);
  });
});
