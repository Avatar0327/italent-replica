// F-476 P2 第 4 轮：大子树在 PG16 上 26 分钟的根因是节点内 O(N²)，不是 SQL（量测见 PR 描述）：
// ① loadOrgSnapshot 给每个组织用 links.filter 扫一遍全部层级链接；② rangeSubtree 每加一个下级就复制一遍整个同级数组、
// 队列用 shift。2.5 万节点各跑几亿次比较 / 复制。本测试守复杂度：不挂 DB，按「访问次数」与「同级大宽度耗时」断言，
// 不依赖机器快慢（耗时上限比线性实现高两个数量级以上）。
import { describe, expect, it } from 'vitest';
import { assembleOrgRecords } from '../../apps/api/src/modules/org/read-model.js';
import { rangeSubtree } from '../../apps/api/src/modules/org-adjustment/preview-input.js';

type Selected = Parameters<typeof assembleOrgRecords>[0][number];
type Link = Parameters<typeof assembleOrgRecords>[1][number];
type Org = Parameters<typeof rangeSubtree>[0] extends ReadonlyMap<string, infer V> ? V : never;

const NODES = 3000;

function selectedOf(i: number): Selected {
  return {
    object: { id: `o${i}`, revision: 1 },
    version: { id: `v${i}`, code: `C${i}`, name: `N${i}` },
  } as unknown as Selected;
}

describe('AC-F476-P2-13 组织快照拼装与范围子树随节点数线性增长', () => {
  it('assembleOrgRecords：每条层级链接只被访问常数次（不是每个组织扫一遍）', () => {
    let reads = 0;
    const links = Array.from({ length: NODES }, (_, i) => {
      const link = { dimension: 'admin', parentOrgId: 'root', sequence: i + 1 } as Record<string, unknown>;
      Object.defineProperty(link, 'versionId', {
        enumerable: true,
        get() {
          reads += 1;
          return `v${i}`;
        },
      });
      return link as unknown as Link;
    });
    const selected = Array.from({ length: NODES }, (_, i) => selectedOf(i));

    const records = assembleOrgRecords(selected, links, new Map());

    expect(records).toHaveLength(NODES);
    // 行为不变：每个组织拿到自己那条行政上级链接
    expect(records[7]?.parents.admin).toEqual({ parentId: 'root', sequence: 8 });
    expect(records[NODES - 1]?.versionId).toBe(`v${NODES - 1}`);
    // 线性实现每条链接读 1 次；旧实现 N×N = 900 万次
    expect(reads).toBeLessThanOrEqual(NODES * 3);
  });

  it('assembleOrgRecords：同一版本多个维度的链接都归到该版本', () => {
    const links = [
      { versionId: 'v0', dimension: 'admin', parentOrgId: 'p', sequence: 1 },
      { versionId: 'v0', dimension: 'business', parentOrgId: 'q', sequence: 2 },
      { versionId: 'v1', dimension: 'admin', parentOrgId: null, sequence: null },
    ] as unknown as Link[];
    const [a, b, c] = assembleOrgRecords([selectedOf(0), selectedOf(1), selectedOf(2)], links, new Map());
    expect(a?.parents).toEqual({
      admin: { parentId: 'p', sequence: 1 },
      business: { parentId: 'q', sequence: 2 },
    });
    expect(b?.parents).toEqual({ admin: { parentId: null, sequence: null } });
    expect(c?.parents).toEqual({});
  });

  it('rangeSubtree：同一个上级下挂 6 万个下级也在 2 秒内算完，结果完整且按层次先后', () => {
    const width = 60_000;
    const orgs = new Map<string, Org>();
    const put = (id: string, parentId: string | null) =>
      orgs.set(id, { id, enabled: true, parents: parentId ? { admin: { parentId, sequence: 1 } } : {} } as Org);
    put('root', null);
    for (let i = 0; i < width; i += 1) put(`c${i}`, 'root');
    put('x', 'c0');

    const started = Date.now();
    const subtree = rangeSubtree(orgs, ['root']);
    const elapsed = Date.now() - started;

    expect(subtree).toHaveLength(width + 2);
    expect(subtree[0]?.id).toBe('root');
    expect(subtree.at(-1)?.id).toBe('x');
    // 线性实现是几十毫秒；旧实现复制 18 亿个元素，本机约 7 秒
    expect(elapsed).toBeLessThan(2000);
  });

  it('rangeSubtree：停用的下级及其整个分支不进子树，选了互为上下级的范围只算一次', () => {
    const orgs = new Map<string, Org>();
    const put = (id: string, parentId: string | null, enabled = true) =>
      orgs.set(id, { id, enabled, parents: parentId ? { admin: { parentId, sequence: 1 } } : {} } as Org);
    put('a', null);
    put('b', 'a');
    put('c', 'b');
    put('d', 'a', false);
    put('e', 'd');
    expect(rangeSubtree(orgs, ['a', 'b']).map((org) => org.id)).toEqual(['a', 'b', 'c']);
  });
});
