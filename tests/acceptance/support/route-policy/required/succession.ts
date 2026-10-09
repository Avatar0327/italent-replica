/**
 * 必需项表：继任管理（R3-T05；租户接口 modules/succession/routes.ts、平台接口 platform-routes.ts）。
 * 契约 PR 与 P0 都没有路由，表为空；实现子 PR 每新增一条路由，按人才盘点（talent-review.ts）的写法逐端点登记
 * 审定过的义务与证据，证据摘要登记在 digests.ts。
 */
import type { RequiredTable } from './types.js';

export const SUCCESSION: RequiredTable = {};
