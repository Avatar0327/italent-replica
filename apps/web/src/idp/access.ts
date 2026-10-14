import { t } from './messages.js';

/**
 * 本片四个统一入口（DEC-431① / DEC-385③）：操作权限、写入完整性、裁剪字段归属、冲突重读回执。
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

export interface IntegrityInput<T extends object> {
  /** 将要原样带回服务端的已有记录（整组提交的全部元素，或逐条写入的那一条）。 */
  rows: readonly T[] | undefined;
  /** 提交时必须原样带回的字段（缺省会被服务端当成新值或补成 null）。 */
  fields?: readonly string[];
  /** 当前可见字段；给出时 fields 里有不可见的即判为不完整（新增也带不出这些字段）。 */
  visible?: readonly string[];
}
export type Integrity = { ok: true } | { ok: false; reason: string };

/**
 * 一之二、写入完整性：已有记录的标识（id）或提交必需字段被裁剪时，带不回原值。
 * 整组提交（如子流程）里缺 id 的元素会被服务端当成新建、原记录被删除；逐条写入的路径带不出 id。
 * 判为不完整时由调用方整组关闭新增 / 编辑 / 移除 / 排序，并展示原因；不补造 id 或默认值（DEC-385③）。
 * 字段值为 null 是“已返回、值为空”，不算缺失。
 */
export function writeIntegrity<T extends object>(input: IntegrityInput<T>): Integrity {
  const rows = (input.rows ?? []) as readonly Readonly<Record<string, unknown>>[];
  if (rows.some((row) => row.id === undefined)) return { ok: false, reason: t.integrity.identity };
  const { fields = [], visible } = input;
  const hidden = !!visible && fields.some((field) => !visible.includes(field));
  if (hidden || rows.some((row) => fields.some((field) => row[field] === undefined)))
    return { ok: false, reason: t.integrity.fields };
  return { ok: true };
}

/**
 * 一之三、完整性约束提交字段：不完整时该字段一律按只读处理。表单不渲染编辑控件、改为展示最新记录，
 * 字段不进 editableFields，patchOnly 也就不会把冲突前的草稿或缺字段的原值带回服务端（DEC-385③）。
 * 只约束按钮和校验不够：草稿可能在完整时编辑、冲突重读后才变得不完整。
 */
export function submitAccess<A extends { visible: boolean; editable: boolean }>(access: A, integrity?: Integrity): A {
  return !integrity || integrity.ok ? access : { ...access, editable: false };
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
