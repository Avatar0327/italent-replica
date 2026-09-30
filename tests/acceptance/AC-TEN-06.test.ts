/**
 * AC-TEN-06（DEC-061，REQ-TEN-001 R6 / REQ-PLT-001 R6）：按租户恢复演练。
 * 须在部署环境（托管 PG 备份、附件存储）就绪后执行，归属部署阶段与 R1-T17。
 * R1-T00 已提供的前置：租户状态 restoring（恢复隔离中）期间业务请求一律 403，见 AC-TEN-02-membership。
 */
import { describe, it } from 'vitest';

describe('AC-TEN-06 按租户恢复演练（归属部署阶段 / R1-T17）', () => {
  it.todo('恢复出的数据与目标时间点差距 ≤ 1h（RPO），开始恢复到开放访问 ≤ 4h（RTO）');
  it.todo('恢复期间 A 处于隔离状态，数据校验与授权对账通过后才开放；撤销过的授权不得复活');
  it.todo('恢复 A 的全过程中 B 的数据与访问不受影响');
  it.todo('审批不重放已处理节点、不补发消息；备份保留 30 天且加密');
});
