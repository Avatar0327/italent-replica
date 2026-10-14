/** DEC-353：PR-C / PR-D 在项目 X 锁、revision / 状态检查之后接入；守卫及其写入与命令同事务提交。 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { WriteContext } from './config-kit.js';
import type { ProjectView } from './project-store.js';

export type ProjectAction = 'start' | 'end' | 'restart';
type Guard = (tx: Tx, ctx: WriteContext, project: ProjectView) => Promise<void>;
const guards: Record<ProjectAction, Set<Guard>> = { start: new Set(), end: new Set(), restart: new Set() };
export function registerProjectGuard(action: ProjectAction, guard: Guard): () => void {
  guards[action].add(guard);
  return () => {
    guards[action].delete(guard);
  };
}
export async function checkProjectGuards(tx: Tx, ctx: WriteContext, action: ProjectAction, project: ProjectView) {
  for (const guard of guards[action]) await guard(tx, ctx, project);
}
type ObjectCheck = (tx: Tx, tenantId: string, projectId: string) => Promise<boolean>;
const objectChecks = new Set<ObjectCheck>();
/** PR-C 建对象表时登记真实查询；PR-B 尚无对象表，所以当前未登记即无对象。PR-C 对象新增先取项目 S 锁。 */
export function registerProjectObjectCheck(check: ObjectCheck): () => void {
  objectChecks.add(check);
  return () => {
    objectChecks.delete(check);
  };
}
export async function requireProjectEmpty(tx: Tx, ctx: WriteContext, id: string) {
  for (const check of objectChecks) {
    if (await check(tx, ctx.tenantId, id)) {
      throw new AppError('CONFLICT', '须先删除项目下全部盘点对象', { reason: 'PROJECT_HAS_OBJECTS' });
    }
  }
}
