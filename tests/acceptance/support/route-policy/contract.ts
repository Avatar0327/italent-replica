/** 现状必测基准的数据结构（冻结文件 baseline/observed-contract.json 的类型）。 */
import type { EdgeFacts } from './probe.js';

export interface ObservedRoute {
  /** 按最终路径前缀确定的模块名（与登记表名无关）。 */
  readonly module: string;
  readonly edge: EdgeFacts;
  /** 维度 → 命中的原语名（排序去重）。 */
  readonly primitives: Readonly<Record<string, readonly string[]>>;
}

export interface ObservedContract {
  readonly routes: Readonly<Record<string, ObservedRoute>>;
  readonly domains: Readonly<Record<string, readonly string[]>>;
}
