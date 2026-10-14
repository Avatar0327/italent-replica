import { t } from './messages.js';

/**
 * 本片三个统一入口（DEC-431① / DEC-385③）：操作权限、裁剪字段归属、冲突重读回执。
 * 页面与组件只调用这里，不在各自位置推算权限、按可能缺失的字段过滤或补造版本号。
 */

export type Operation = 'add' | 'edit' | 'remove' | 'reorder';
export interface OperationInput {
  /** 对象自身的数据操作权（服务端 dataOperations：create / update / delete）；缺失即无权。 */
  operations: Readonly<Record<string, boolean>> | undefined;
  /** 本对象当前可编辑的字段。 */
  editable: readonly string[];
  /** 新增时必须能填写的字段；有一个不可编辑就不能新增。 */
  required?: readonly string[];
  /** 业务开关（父字段可编辑、计划进行中、模块开启制定任务等）：每一项都必须明确为 true。 */
  switches?: readonly (boolean | null | undefined)[];
}

/**
 * 一、操作权限：新增 / 编辑 / 删除 / 排序能否执行。拿不到明确授权就拒绝（fail-closed，AGENTS.md §2）。
 * 排序改的是对象自身的顺序号，按编辑权判定（DEC-309④-2，process-service 同口径）。
 */
export function operationAccess(input: OperationInput): Record<Operation, boolean> {
  const on = (input.switches ?? []).every((value) => value === true);
  const granted = (operation: 'create' | 'update' | 'delete') => on && input.operations?.[operation] === true;
  return {
    add: granted('create') && (input.required ?? []).every((field) => input.editable.includes(field)),
    edit: granted('update') && input.editable.length > 0,
    remove: granted('delete'),
    reorder: granted('update'),
  };
}

/**
 * 二、裁剪字段归属：按可能被裁剪的归属字段（如 moduleId）分组。字段缺失或指向不在场的归属时，
 * 记录归入 unassigned 由页面放在“未归属”位置展示，不能因字段无权查看而整条消失（DEC-431①）。
 */
export function groupByOwner<T>(
  rows: readonly T[] | undefined,
  ownerOf: (row: T) => string | null | undefined,
  owners: readonly string[],
) {
  const groups = new Map<string, T[]>(owners.map((id) => [id, []]));
  const unassigned: T[] = [];
  for (const row of rows ?? []) {
    const owner = ownerOf(row);
    const group = owner ? groups.get(owner) : undefined;
    if (group) group.push(row);
    else unassigned.push(row);
  }
  return { of: (id: string) => groups.get(id) ?? [], unassigned };
}

/** 重读回执无效：冲突锁不解开，提示用户刷新页面。 */
export class RereadError extends Error {
  constructor() {
    super(t.rereadFailed);
  }
}
/**
 * 三、冲突重读回执：必须是同一条记录且带有效 revision，否则视为无效回执并抛出，
 * 不用 `?? 0` 之类补造版本号（补造会解锁并带着 If-Match: 0 重提）。
 */
export function rereadReceipt(row: { id?: unknown; revision?: unknown } | null | undefined, id: string) {
  const revision = row?.revision;
  if (row?.id !== id || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    throw new RereadError();
  return { id, revision };
}
