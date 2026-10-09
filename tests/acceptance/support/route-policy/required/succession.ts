/**
 * 必需项表：继任管理（modules/succession/routes.ts，R3-T05）。契约 PR 没有路由，表为空；实现子 PR 每新增一条路由，
 * 按人才盘点（talent-review.ts）的写法逐端点登记审定过的义务与证据，证据摘要登记在 digests.ts。
 */
import type { RequiredTable } from './types.js';

export const SUCCESSION: RequiredTable = {};
