/**
 * DEC-273②：回退超编警告审计（employment.establishment.exceeded-confirmed）挂在任职业务对象上，但其中的
 * 控编模式与被判超编的部门 / 职位 / 区间属于编制数据：列表变更、变更内容与详情都按查看人的编制数据范围另行裁剪，
 * 编制范围为空或不覆盖该部门的查看者看不到这些值。
 */
import type { AuditFieldChange } from '@italent/domain';
import { auditFieldCode } from '@italent/domain';
import type { ModuleScope } from '../modules/permission/scope-types.js';

const ESTABLISHMENT_KEYS = new Set(['strictControl', 'segments']);

export interface ReversalAuditAccess {
  /** 有编制对象查看权且数据范围非空。 */
  readonly visible: boolean;
  readonly scope: ModuleScope | null;
}

export class ReversalAuditFields extends Set<string> {
  constructor(
    private readonly base: ReadonlySet<string> | undefined,
    private readonly access: ReversalAuditAccess,
  ) {
    super();
  }

  override has(path: string): boolean {
    const root = path.split('.')[0]!;
    if (ESTABLISHMENT_KEYS.has(root)) return this.access.visible;
    if (this.base === undefined) return true;
    return this.base.has(path) || this.base.has(auditFieldCode(path));
  }

  private orgVisible(id: unknown): boolean {
    const scope = this.access.scope;
    if (!this.access.visible || !scope) return false;
    return scope.all || (typeof id === 'string' && scope.orgIds.includes(id));
  }

  /** 只留编制范围内部门的分段；不是数组时按不可见处理。 */
  segments(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (segment): segment is Record<string, unknown> =>
        segment !== null &&
        typeof segment === 'object' &&
        this.orgVisible((segment as { departmentId?: unknown }).departmentId),
    );
  }

  /** 详情 before / after：范围外的分段去掉；一段都看不到时控编模式一并隐藏。 */
  project(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!('segments' in record) && !('strictControl' in record)) return value;
    const segments = this.segments(record.segments);
    const { strictControl: _strict, segments: _segments, ...rest } = record;
    return segments.length ? { ...rest, strictControl: record.strictControl, segments } : rest;
  }

  /** 列表变更：分段按范围投影后重新渲染显示值；一段都看不到时连同控编模式一起去掉。 */
  changes(changes: readonly AuditFieldChange[]): AuditFieldChange[] {
    const segments = changes.find((change) => change.field === 'segments');
    const visible = segments ? this.segments(segments.to) : [];
    return changes.flatMap((change) => {
      const root = change.field.split('.')[0]!;
      if (!ESTABLISHMENT_KEYS.has(root)) return this.has(change.field) ? [change] : [];
      if (!visible.length) return [];
      if (change.field !== 'segments') return [change];
      const { fromText: _from, toText: _to, ...rest } = change;
      return [{ ...rest, from: this.segments(change.from), to: visible }];
    });
  }
}
