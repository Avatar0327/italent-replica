/**
 * 离职下游清单目标的可见性订阅表（叶模块，F-512）：registerDownstreamVisibility 原在 exit-downstream.ts。
 * 订阅方（approval-flow 在 exit-terminate-flows、succession-record 在 succession/exit-store）在自己模块顶层 / 安装时登记，
 * 而 exit-downstream 位于“审批引擎 ↔ 任职上下文”的导入环上：以订阅方为首个入口时，订阅方先于 exit-downstream 求值，
 * 登记时读到的表尚未初始化（TDZ）。本文件只依赖类型，不在环上。exit-downstream 对原名再导出。
 */
import type { Tx } from '@italent/db';
import type { DownstreamTarget } from './exit-downstream.js';
import type { EmploymentContext } from './types.js';

export type DownstreamVisibilityCheck = (tx: Tx, ctx: EmploymentContext, target: DownstreamTarget) => Promise<boolean>;

const downstreamVisibility = new Map<string, DownstreamVisibilityCheck>();

export function registerDownstreamVisibility(type: string, visible: DownstreamVisibilityCheck) {
  downstreamVisibility.set(type, visible);
}

/** 按目标类型取已登记的可见性判定；未登记返回 undefined（调用方走内置分支）。 */
export function downstreamVisibilityOf(type: string): DownstreamVisibilityCheck | undefined {
  return downstreamVisibility.get(type);
}
