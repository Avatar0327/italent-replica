/** D4 / SP-15：通过装配登记公开端口验收；不在测试中复制 B5 求值实现。 */
import { describe, expect, it } from 'vitest';
import { SUCCESSION_PORTS, installSuccessionPorts } from '../../apps/api/src/modules/succession/ports.js';
import { orgHealthComputePort } from '../../apps/api/src/modules/talent-review/health-port.js';

describe('AC-SC-health-sync 计算端口装配', () => {
  it('SUCCESSION_PORTS 登记可重复装配的 compute + listLevels 模块单例', () => {
    expect(SUCCESSION_PORTS.orgHealthCompute).toBeDefined();
    expect(SUCCESSION_PORTS.orgHealthCompute?.compute).toBeTypeOf('function');
    expect(SUCCESSION_PORTS.orgHealthCompute?.listLevels).toBeTypeOf('function');
    installSuccessionPorts();
    installSuccessionPorts();
    expect(orgHealthComputePort()).toBe(SUCCESSION_PORTS.orgHealthCompute);
  });
});
