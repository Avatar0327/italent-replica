/**
 * F-470（F-440 #555 审查 P3-1 后补）：级联停用的行政子树遍历器 adminSubtree 纯函数补测。
 * 现数据模型的层级校验使环不可达（`10` §9 / F-440），这里锁定防御性边界：根回边、非根环、重复节点下
 * 每个 ID 只输出一次、根不入结果、不死循环；正常多级多兄弟按 BFS、兄弟按快照出现顺序。每条都断言完整输出数组。
 */
import { describe, expect, it } from 'vitest';
import { adminSubtree, type SubtreeNode } from '../../apps/api/src/modules/org/subtree.js';

/** [id, 行政上级 id | undefined]；undefined = 没有行政上级。快照顺序即数组顺序。 */
function snapshot(...rows: [string, string | undefined][]): SubtreeNode[] {
  return rows.map(([id, parentId]) => ({ id, parents: parentId ? { admin: { parentId } } : {} }));
}

describe('F-470 adminSubtree：防御性边界', () => {
  it('根节点回边：后代指回根，根不出现在结果中且不死循环', () => {
    // R 的上级链里出现自身：R→A→B，且 R 又把 B 当上级（环 R→A→B→R 里 R 的回边）
    const nodes = snapshot(['R', 'B'], ['A', 'R'], ['B', 'A']);
    expect(adminSubtree(nodes, 'R')).toEqual(['A', 'B']);
  });

  it('根节点回边：后代的子节点记录指向根的直接回环（A→R 且 R→A），结果只含 A', () => {
    expect(adminSubtree(snapshot(['R', 'A'], ['A', 'R']), 'R')).toEqual(['A']);
  });

  it('非根环：A→B→C→A 挂在根下，每个节点只输出一次', () => {
    // R→A→B→C，且 A 又被登记为 C 的下级，构成 A→B→C→A 回路
    const nodes = snapshot(['A', 'R'], ['B', 'A'], ['C', 'B'], ['A', 'C']);
    expect(adminSubtree(nodes, 'R')).toEqual(['A', 'B', 'C']);
  });

  it('非根环：环完全在根之外（不与根相连）→ 取不到，返回空数组且不死循环', () => {
    const nodes = snapshot(['A', 'B'], ['B', 'C'], ['C', 'A'], ['R', undefined]);
    expect(adminSubtree(nodes, 'R')).toEqual([]);
  });

  it('非根环：环的入口在根下，环内其余节点只输出一次', () => {
    // R→A，且 A→B→C→B 的环（B、C 互为上级）
    const nodes = snapshot(['A', 'R'], ['B', 'A'], ['C', 'B'], ['B', 'C']);
    expect(adminSubtree(nodes, 'R')).toEqual(['A', 'B', 'C']);
  });

  it('重复节点：快照里同一 ID 出现两次（同一上级），只输出一次，位置按首次出现', () => {
    const nodes = snapshot(['A', 'R'], ['B', 'R'], ['A', 'R'], ['C', 'R']);
    expect(adminSubtree(nodes, 'R')).toEqual(['A', 'B', 'C']);
  });

  it('重复节点：同一子节点被两个不同上级登记，只输出一次，先到先得（BFS 层序）', () => {
    // D 同时挂在 A 与 B 下；A 先于 B 出队，所以 D 紧随 B 之后在第二层按 A 的登记位置出现
    const nodes = snapshot(['A', 'R'], ['B', 'R'], ['D', 'A'], ['D', 'B'], ['E', 'B']);
    expect(adminSubtree(nodes, 'R')).toEqual(['A', 'B', 'D', 'E']);
  });

  it('多级 + 多兄弟：三层、每层至少两个兄弟，按 BFS 层序，兄弟按快照出现顺序', () => {
    // 快照顺序故意打乱：深层节点出现在浅层之前，验证输出是 BFS 而不是快照顺序或 DFS
    const nodes = snapshot(
      ['C2', 'B2'],
      ['B2', 'A2'],
      ['C1', 'B1'],
      ['A2', 'R'],
      ['B1', 'A1'],
      ['A1', 'R'],
      ['C3', 'B1'],
      ['X', undefined],
    );
    // 第一层按快照出现顺序 A2、A1；第二层 A2 的孩子 B2 先、A1 的孩子 B1 后；第三层 B2 的 C2，B1 的 C1、C3
    expect(adminSubtree(nodes, 'R')).toEqual(['A2', 'A1', 'B2', 'B1', 'C2', 'C1', 'C3']);
  });

  it('根无下级 / 全部无行政上级 / 空快照：返回空数组', () => {
    expect(adminSubtree(snapshot(['R', undefined], ['A', undefined]), 'R')).toEqual([]);
    expect(adminSubtree(snapshot(['R', undefined], ['A', 'B'], ['B', 'A']), 'R')).toEqual([]);
    expect(adminSubtree([], 'R')).toEqual([]);
  });

  it('只看行政维度：没有 admin 上级（只有其它维度）的节点不入结果', () => {
    const nodes: SubtreeNode[] = [
      { id: 'A', parents: { admin: { parentId: 'R' } } },
      { id: 'B', parents: {} }, // 其它维度的上级在 Partial<Record<...>> 里，但 admin 缺失
    ];
    expect(adminSubtree(nodes, 'R')).toEqual(['A']);
  });
});
