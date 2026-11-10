/**
 * 审批变量与矩阵的审计可见字段（F-326 S1 返工 P2-1，设计 §4.5）。
 *
 * 这四类审计对象（approval-public-variable / -application-variable / -matrix / -matrix-row）的键不在「审批流程」
 * 字段目录里：dataType / defaultValue / usageScopes / appId / origin*，矩阵结构里动态的 row:<id> / column:<id>，
 * 行删除快照里的 matrixId / cells / columns。直接套用该目录会让有全部字段权限的查看人也读到空详情；而按路径末段
 * 匹配又会让 column:<id>.name 借「名称」权限泄露列名。所以这里给出精确路径集合，并只放行受控的动态路径。
 *
 * 权限口径（沿用「审批流程」对象，不新增权限对象与授权项，DEC-404）：
 * - 编码 / 名称 / 描述 / 状态 / revision 跟随同名字段；
 * - 其余内容（变量的类型、默认值、适用范围、应用、来源，矩阵的列、行、单元格、删除快照）跟随「节点」字段——
 *   它们的业务含义都是“谁来审批”的配置，与流程节点的审批人来源同级；
 * - 没有对应字段权限时一律不出现（fail-closed），伪造的动态键（非标准 UUID、其他前缀）不放行。
 */
import { ExactAuditFields } from './transfer-linkage.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** 矩阵结构的动态键：row:<id>[.seq | .cells[.<列id>]]、column:<id>[.<列定义字段>]。 */
const STRUCTURE_PATH = new RegExp(
  `^(?:row:${UUID}(?:\\.seq|\\.cells(?:\\.${UUID})?)?` +
    `|column:${UUID}(?:\\.(?:kind|dimension|includeChildren|name|seq|allowMultiple))?)$`,
  'i',
);
/** 行删除快照的动态键：cells.<列id>、columns.<列id>[.name | .kind]。 */
const SNAPSHOT_PATH = new RegExp(`^(?:cells\\.${UUID}|columns\\.${UUID}(?:\\.(?:name|kind))?)$`, 'i');

/** 跟随同名「审批流程」字段的基础键：审计键 → 字段目录里的字段。 */
const BASIC_KEYS: Readonly<Record<string, string>> = {
  code: 'code',
  matrixCode: 'code',
  name: 'name',
  description: 'description',
  status: 'status',
  revision: 'revision',
};

/** 内容键：变量的类型 / 默认值 / 适用范围 / 应用 / 来源（DEC-858），矩阵删除快照的固定键。 */
const CONTENT_KEYS: readonly string[] = [
  'dataType',
  'defaultValue',
  'usageScopes',
  'appId',
  'origin',
  'originProcessId',
  'originVersionId',
  'originNodeKey',
  'originSlot',
  'matrixId',
  'seq',
  'cells',
  'columns',
];

const CONTENT_FIELD = 'nodes';

/** 精确路径集合 + 受控动态路径；沿用 ExactAuditFields 的语义（不按末段回退），has() 另认可合规的动态键。 */
export class ControlledAuditFields extends ExactAuditFields {
  constructor(
    keys: Iterable<string>,
    private readonly dynamic: boolean,
  ) {
    super(keys);
  }

  override has(path: string): boolean {
    return super.has(path) || (this.dynamic && (STRUCTURE_PATH.test(path) || SNAPSHOT_PATH.test(path)));
  }
}

/** 由查看人在「审批流程」对象上的可见字段推出变量 / 矩阵审计的可见键；undefined = 不受字段限制。 */
export function approvalContentFields(viewable: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (viewable === undefined) return undefined;
  const keys = Object.entries(BASIC_KEYS)
    .filter(([, field]) => viewable.has(field))
    .map(([key]) => key);
  const content = viewable.has(CONTENT_FIELD);
  return new ControlledAuditFields(content ? [...keys, ...CONTENT_KEYS] : keys, content);
}
