/**
 * AC-APV-F478-04（S1，设计 §2.2）：路由随流程版本，发起时冻结。发布 v2 把 Else 改到 END 后，
 * 在 v1 上发起的实例仍按 v1 走 N2，新发起的实例按 v2 直接结束。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approveCurrent,
  approveTo,
  otherwise,
  pendingKey,
  publishRouted,
  republishRouted,
  routeScene,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-04 路由版本固化', () => {
  it('v1 发起的实例按 v1 走，v2 发起的按 v2 走', async () => {
    const s = await routeScene(testDb().db, 'f478-04');
    const nodes = s.nodes().slice(0, 3);
    const process = await publishRouted(s.w, nodes, {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });

    const early = await s.start(s.depts.d2);
    expect(pendingKey(early)).toBe('n1');

    await republishRouted(s.w, process, { n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('END'))] });

    const afterEarly = await approveCurrent(s, early);
    expect(pendingKey(afterEarly)).toBe('n2');

    const late = await s.start(s.depts.d2);
    const afterLate = await approveCurrent(s, late);
    expect(afterLate.status).toBe('approved');
    expect(afterLate.tasks.filter((t) => t.nodeKey !== 'n1')).toEqual([]);
  });
});
