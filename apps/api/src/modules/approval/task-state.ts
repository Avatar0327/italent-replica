import type { TaskStatus } from './store.js';

/** 仍在办的任务状态；独立于 store 初始化，避免会签模块顶层计算席位集合时形成依赖环。 */
export const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'queued', 'add_signed']);
