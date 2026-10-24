import * as domain from '@italent/domain';
import { describe, expect, it } from 'vitest';

const org = (id: string) => ({ kind: 'org' as const, id });
const item = (id: string) => ({ kind: 'item' as const, id });
const nodes = [
  { ref: org('root'), parent: null },
  { ref: org('child'), parent: org('root') },
  { ref: org('leaf'), parent: org('child') },
  { ref: org('outside'), parent: null },
  { ref: item('new'), parent: org('leaf') },
  { ref: item('nested'), parent: item('new') },
  { ref: item('out'), parent: org('outside') },
];

describe('AC-OA-42 范围包含纯函数（设计 §5.6，生效日行政树由调用方提供）', () => {
  it('根、自身、行政子树与本单新增组织的递归上级在范围内，多根取并集', () => {
    for (const ref of [org('root'), org('child'), org('leaf'), item('new'), item('nested')])
      expect(domain.isInAdjustmentRange(ref, ['root'], nodes), ref.id).toBe(true);
    expect(domain.isInAdjustmentRange(org('outside'), ['root'], nodes)).toBe(false);
    expect(domain.isInAdjustmentRange(item('out'), ['root', 'outside'], nodes)).toBe(true);
    expect(domain.isInAdjustmentRange(org('root'), ['child'], nodes)).toBe(false);
  });
  it('空范围、未知组织、孤儿、循环与同名组织/新增项不误放行', () => {
    expect(domain.isInAdjustmentRange(org('root'), [], nodes)).toBe(false);
    expect(domain.isInAdjustmentRange(org('missing'), ['missing'], nodes)).toBe(false);
    const invalid = [
      ...nodes,
      { ref: item('root'), parent: org('missing') },
      { ref: item('a'), parent: item('b') },
      { ref: item('b'), parent: item('a') },
    ];
    for (const ref of [item('root'), item('a'), item('b'), org('new')])
      expect(domain.isInAdjustmentRange(ref, ['root'], invalid), `${ref.kind}:${ref.id}`).toBe(false);
  });
  it('输入顺序与重复范围根不影响结果，不修改输入', () => {
    const before = structuredClone(nodes);
    expect(domain.isInAdjustmentRange(item('nested'), ['root', 'root'], [...nodes].reverse())).toBe(true);
    expect(nodes).toEqual(before);
  });
});
