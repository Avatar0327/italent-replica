/**
 * DEC-273② / DEC-284③：回退超编警告审计（employment.establishment.exceeded-confirmed）挂在任职业务对象上，但其中的
 * 控编模式与被判超编的部门 / 职位 / 区间属于编制数据：列表变更、变更内容与详情都按查看人的**编制数据范围**与
 * **编制字段权限**另行投影——范围为空或不覆盖该部门的看不到该段；分段里的每个键按对应的编制字段编码
 * （departmentId ↔ orgId、positionId、from / until ↔ periodStart / periodEnd、strictControl）裁剪，
 * 变更文本按投影后的值重新生成。
 */
import type { AuditFieldChange } from '@italent/domain';
import { auditFieldCode } from '@italent/domain';
import type { ModuleScope } from '../modules/permission/scope-types.js';

const ESTABLISHMENT_KEYS = new Set(['strictControl', 'segments']);
/** 分段键 → 编制对象字段编码（module-actions.ts 的 establishment 字段表）。 */
const SEGMENT_FIELD_CODES: Readonly<Record<string, string>> = {
  departmentId: 'orgId',
  positionId: 'positionId',
  from: 'periodStart',
  until: 'periodEnd',
  strictControl: 'strictControl',
};

export interface ReversalAuditAccess {
  /** 有编制对象查看权且数据范围非空。 */
  readonly visible: boolean;
  readonly scope: ModuleScope | null;
  /** 编制对象的可见字段；undefined = 不限。 */
  readonly fields: ReadonlySet<string> | undefined;
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
    if (root === 'strictControl') return this.access.visible && this.fieldVisible('strictControl');
    if (root === 'segments') return this.access.visible;
    if (this.base === undefined) return true;
    return this.base.has(path) || this.base.has(auditFieldCode(path));
  }

  private fieldVisible(code: string): boolean {
    return this.access.fields === undefined || this.access.fields.has(code);
  }

  private orgVisible(id: unknown): boolean {
    const scope = this.access.scope;
    if (!this.access.visible || !scope) return false;
    return scope.all || (typeof id === 'string' && scope.orgIds.includes(id));
  }

  /** 只留编制范围内部门的分段，再按编制字段权限裁剪每段的键；没有可见键的段去掉；不是数组时按不可见处理。 */
  segments(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((segment) => {
      if (segment === null || typeof segment !== 'object') return [];
      const record = segment as Record<string, unknown>;
      if (!this.orgVisible(record.departmentId)) return [];
      const projected = Object.fromEntries(
        Object.entries(record).filter(([key]) => {
          const code = SEGMENT_FIELD_CODES[key];
          return code !== undefined && this.fieldVisible(code);
        }),
      );
      return Object.keys(projected).length ? [projected] : [];
    });
  }

  /** 详情 before / after：分段按范围与字段投影；一段都看不到时控编模式一并隐藏。 */
  project(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!('segments' in record) && !('strictControl' in record)) return value;
    const segments = this.segments(record.segments);
    const { strictControl: _strict, segments: _segments, ...rest } = record;
    if (!segments.length) return rest;
    return this.has('strictControl')
      ? { ...rest, strictControl: record.strictControl, segments }
      : { ...rest, segments };
  }

  /** 列表变更：分段按范围与字段投影后重新渲染显示值；一段都看不到时连同控编模式一起去掉。 */
  changes(changes: readonly AuditFieldChange[]): AuditFieldChange[] {
    const segments = changes.find((change) => change.field === 'segments');
    const visible = segments ? this.segments(segments.to) : [];
    return changes.flatMap((change) => {
      const root = change.field.split('.')[0]!;
      if (!ESTABLISHMENT_KEYS.has(root)) return this.has(change.field) ? [change] : [];
      if (!visible.length || !this.has(change.field)) return [];
      if (change.field !== 'segments') return [change];
      const { fromText: _from, toText: _to, ...rest } = change;
      return [{ ...rest, from: this.segments(change.from), to: visible }];
    });
  }
}
