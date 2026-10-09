/**
 * 继任对外端口的装配登记位（R3-T05 设计 §6.3；同步协议 SP-15）：createApp 装配本模块时调用 installSuccessionPorts，
 * 把本模块的实现登记给 T04。组织健康度计算端口随 PR-D 填入 SUCCESSION_PORTS；在此之前不登记，T04 页面的
 * “计算健康度”保持 400 HEALTH_COMPUTE_UNAVAILABLE（不登记占位实现，避免返回假结果）。
 * 实现必须是模块级单例：createApp 每装配一次都会调用本函数，T04 只接受同一实例的重复登记。
 */
import { registerOrgHealthComputePort, type OrgHealthComputePort } from '../talent-review/health-port.js';

export interface SuccessionPorts {
  readonly orgHealthCompute?: OrgHealthComputePort;
}

export const SUCCESSION_PORTS: SuccessionPorts = {};

export function installSuccessionPorts(ports: SuccessionPorts = SUCCESSION_PORTS): void {
  if (ports.orgHealthCompute) registerOrgHealthComputePort(ports.orgHealthCompute);
}
