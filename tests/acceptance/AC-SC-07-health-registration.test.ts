/** R3-T05 B5 / 设计 §4.4：计算和重置复用 B3a 生产 worker，不以测试专用 handler 代替。 */
import { describe, expect, it } from 'vitest';
import { SUCCESSION_CALC_KINDS } from '../../apps/api/src/modules/succession/calc-contract.js';

describe('AC-SC-07 健康度生产 kind 登记', () => {
  it.each(['org_health', 'org_health_reset'] as const)('%s 有唯一的组织计算宿主', (kind) => {
    const handlers = SUCCESSION_CALC_KINDS.filter((handler) => handler.kind === kind);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.objectType).toBe('org');
  });
});
