/**
 * 准备度共享字典的可信端口（DEC-301①；设计 §2.1、§6.5“准备度字典端口”）：供 R3-T05 继任记录、R3-T06 人才池与 T04 提名行
 * 读取与选用。在调用方的租户事务内执行（RLS 只读到当前租户），不做权限判断与字段裁剪——调用方按自己的业务权限决定
 * 展示哪些字段；端口只给出 id / code / name / description / color / sortNo / enabled。
 * 引用守卫：引用方在加载时登记“该准备度是否被我引用”，删除准备度时在同一事务内逐个询问（任一引用即 409 READINESS_IN_USE）。
 * 取锁顺序：选用方对准备度行加 FOR SHARE（selectReadiness），停用 / 删除先对它 FOR UPDATE，“停用后不可新选用”与
 * “被引用不可删”在并发下同样成立。
 */
import { and, asc, eq, talentReadinessLevels, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';

export interface ReadinessLevel {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string;
  readonly sortNo: number;
  readonly enabled: boolean;
}

export interface ReadinessPort {
  /** 全部准备度（含已停用，调用方按 enabled 决定能否新选用），按排序号、编码。 */
  list(tx: Tx, tenantId: string): Promise<readonly ReadinessLevel[]>;
}

const R = talentReadinessLevels;
const columns = {
  id: R.id,
  code: R.code,
  name: R.name,
  description: R.description,
  color: R.color,
  sortNo: R.sortNo,
  enabled: R.enabled,
};

export const readinessPort: ReadinessPort = {
  list: (tx, tenantId) =>
    tx.select(columns).from(R).where(eq(R.tenantId, tenantId)).orderBy(asc(R.sortNo), asc(R.code)),
};

/**
 * 新选用一条准备度：共享锁 → 存在且启用。不存在 400 READINESS_UNKNOWN；已停用 400 READINESS_DISABLED
 * （同步协议 SP-14 R2 / R3 同名码；已有引用保留，不经本函数）。
 */
export async function selectReadiness(tx: Tx, tenantId: string, id: string): Promise<ReadinessLevel> {
  const [row] = await tx
    .select(columns)
    .from(R)
    .where(and(eq(R.tenantId, tenantId), eq(R.id, id.toLowerCase())))
    .for('share');
  if (!row) throw new AppError('VALIDATION_FAILED', '准备度不存在', { reason: 'READINESS_UNKNOWN' });
  if (!row.enabled) throw new AppError('VALIDATION_FAILED', '准备度已停用，不能选用', { reason: 'READINESS_DISABLED' });
  return row;
}

/** 返回引用方编码（如 'SUCCESSION_RECORD'）表示被引用；返回 null 表示未引用。 */
export type ReadinessReferenceGuard = (tx: Tx, tenantId: string, readinessId: string) => Promise<string | null>;

const guards: ReadinessReferenceGuard[] = [];

export function registerReadinessReferenceGuard(guard: ReadinessReferenceGuard): void {
  if (!guards.includes(guard)) guards.push(guard);
}

export async function readinessReferrer(tx: Tx, tenantId: string, readinessId: string): Promise<string | null> {
  for (const guard of guards) {
    const referrer = await guard(tx, tenantId, readinessId);
    if (referrer) return referrer;
  }
  return null;
}
