import type { TaskStatus } from './store.js';

/** 仍在办的任务状态；独立于 store 初始化，避免会签模块顶层计算席位集合时形成依赖环。 */
export const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'queued', 'add_signed']);
/**
 * 节点上“还没办完”的任务状态：引擎 afterNodeApproved 据此判断单人节点能否流转，详情 path 据此判断一次激活是否已结算，
 * 两处共用同一个集合。add_signed（前加签时原审批人挂起的任务）不算：加签人的任务在办，本节点自然没有走完。
 */
export const AWAITING_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'queued']);
