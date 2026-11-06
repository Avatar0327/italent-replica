/**
 * AC-APV-F478-08（S1，设计 §3.3）：出口到 END 的终局语义，以及不同意出口接到后续节点。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  approveTo,
  direct,
  disagreeCurrent,
  disagreeTo,
  pendingKey,
  publishRouted,
  routeScene,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-08 出口去向', () => {
  it('同意出口直指 END → 实例通过，终局只发生一次', async () => {
    const s = await routeScene(testDb().db, 'f478-08-end');
    await publishRouted(s.w, s.nodes().slice(0, 3), { n1: [approveTo(direct('END'))] });
    const done = await approveCurrent(s, await s.start(s.depts.d1));
    expect(done.status).toBe('approved');
    expect(done.logs.filter((l) => l.event === 'complete')).toHaveLength(1);
    expect(done.tasks.filter((t) => t.nodeKey !== 'n1')).toEqual([]);
    expect((await s.w.business(done.businessId)).status).not.toBe('in_review');
  });

  it('不同意出口接到 N3 → 流程继续，N3 激活行 from_exit = disagree', async () => {
    const s = await routeScene(testDb().db, 'f478-08-disagree');
    await publishRouted(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {
      n1: [disagreeTo(direct('n3'))],
    });
    const view = await disagreeCurrent(s, await s.start(s.depts.d1));
    expect(view.status).toBe('running');
    expect(pendingKey(view)).toBe('n3');
    const rows = await activationsOf(s.w, view.id);
    expect(rows.at(-1)).toMatchObject({ node_key: 'n3', from_node_key: 'n1', from_exit: 'disagree' });
  });

  it('未配置去向的不同意出口 → 不通过（与 main 一致）', async () => {
    const s = await routeScene(testDb().db, 'f478-08-default');
    await publishRouted(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {
      n1: [approveTo(direct('n2'))],
    });
    const view = await disagreeCurrent(s, await s.start(s.depts.d1));
    expect(view.status).toBe('disapproved');
  });
});
