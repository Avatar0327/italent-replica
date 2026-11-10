/**
 * Offer 单 / Offer 批已办读取的值投影（F-476 P6，设计 §5.4、§6）。
 * 已办读者读办理时冻结的那一份：值来自办理份里的 snapshot，显示标签来自办理份的扩展（content.ts），
 * 一律不退回现值、不从当前成员表重建（DEC-807）。披露 = 节点表单 ∩ 办理时上限 ∩ 当前字段权限（DEC-801 D3），
 * 名称与来源 ID 同进同出：来源字段被裁，名称同时消失；办理时没有的标签，事后放宽权限也不补。
 * 历史份不再按当前数据范围裁行（DEC-834④）。
 */
import { OFFER_NAME_FIELDS } from '@italent/domain';
import { approvalError, type Row } from '../approval/context.js';
import { capViewable, type FrozenContent } from '../approval/handling-content.js';
import {
  BATCH_ROW_LABEL_KEYS,
  REF_NAME_SOURCES,
  type Labels,
  type OfferBatchContent,
  type OfferContent,
} from './content.js';

/** 批子表列 → Offer 对象字段；学校 / 学历 Offer 上没有对应字段（恒为空），不受字段权限约束。 */
const BATCH_COLUMN_SOURCE: Readonly<Record<string, string | null>> = {
  name: 'name',
  school: null,
  education: null,
  plannedEntryDate: 'plannedEntryDate',
  departmentId: 'departmentId',
  positionId: 'positionId',
  baseSalary: 'salaryAfterRegular',
};

const sourceOf = (labelKey: string) => (OFFER_NAME_FIELDS as Readonly<Record<string, string>>)[labelKey];
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 办理份的扩展形状不对：按缺份处理（失败闭合），不拿 snapshot 单独冒充完整份。 */
const malformed = () =>
  approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');

function labelsOf(source: unknown): Labels {
  if (!isRecord(source) || !isRecord(source.labels)) throw malformed();
  return source.labels as Labels;
}

/**
 * 单个 Offer：标签只随已披露的来源字段下发。审批中心的引用名（departmentIdName 等）由冻结值占位：
 * 来源 ID 已下发就一定带上这个键（办理时没捕获到则为 null），取名函数见到已有键便不再按当前名称补。
 */
export function projectOfferValues(frozen: FrozenContent, values: Row, disclosed: ReadonlySet<string>): Row {
  const ext = frozen.content.ext as Partial<OfferContent> | null;
  const labels = labelsOf(ext);
  if (!isRecord(ext!.refs)) throw malformed();
  const refs = ext!.refs as Readonly<Record<string, string | null | undefined>>;
  const result: Row = { ...values };
  for (const [key, value] of Object.entries(labels)) {
    const source = sourceOf(key);
    if (source && disclosed.has(source)) result[key] = value;
  }
  for (const [key, source] of Object.entries(REF_NAME_SOURCES)) {
    if (disclosed.has(source) && typeof values[source] === 'string') result[key] = refs[key] ?? null;
  }
  return result;
}

/**
 * 批办理份的完整性：扩展形状（rows 数组、rowCeiling 为 null 或数组）+ 未经裁剪的冻结行逐行都有标签条目。
 * 采集时每行都写一条标签（content.ts），缺条目只可能是份残缺。必须在任何字段裁剪 / 提前返回之前做完：
 * 查看人看不到 offers 不等于份完好，残缺份一律 503（R2 / R3 P2-3，设计 §3.4、§5.1）。
 */
function checkedBatchCopy(frozen: FrozenContent) {
  const ext = frozen.content.ext as Partial<OfferBatchContent> | null;
  if (!isRecord(ext) || !Array.isArray(ext.rows)) throw malformed();
  if (ext.rowCeiling !== null && !Array.isArray(ext.rowCeiling)) throw malformed();
  const labelsByOffer = new Map<string, unknown>();
  for (const row of ext.rows as unknown[]) if (isRecord(row)) labelsByOffer.set(String(row.offerId), row.labels);
  const frozenLines: unknown = frozen.content.snapshot.values.offers;
  if (!Array.isArray(frozenLines)) throw malformed();
  for (const line of frozenLines) {
    if (!isRecord(line) || !isRecord(labelsByOffer.get(String(line.offerId)))) throw malformed();
  }
  return { rowCeiling: ext.rowCeiling, labelsByOffer: labelsByOffer as ReadonlyMap<string, Labels> };
}

/**
 * Offer 批：行（成员、顺序、取值）取自办理时的 snapshot，批行内列按 Offer 对象字段权限披露：
 * 办理时上限 ∩ 查看人当前 Offer 字段权限；行不丢（不按单个 Offer 的数据范围丢行，DEC-057），隐藏列不留计数。
 */
export function projectBatchValues(
  frozen: FrozenContent,
  values: Row,
  rowViewable: ReadonlySet<string> | undefined,
): Row {
  const { rowCeiling, labelsByOffer } = checkedBatchCopy(frozen); // 先校验整份，下面才按披露裁剪
  const lines = values.offers;
  if (!Array.isArray(lines)) return values; // 批的 offers 字段已被裁掉，整个子表不披露
  const allowed = capViewable(rowViewable, rowCeiling ? new Set(rowCeiling) : null);
  const open = (source: string | null | undefined) => source === null || !allowed || (!!source && allowed.has(source));
  const offers = (lines as Row[]).map((line) => {
    const cell: Row = { offerId: line.offerId };
    for (const [column, source] of Object.entries(BATCH_COLUMN_SOURCE)) {
      if (open(source) && Object.hasOwn(line, column)) cell[column] = line[column];
    }
    const labels = labelsByOffer.get(String(line.offerId));
    if (!labels) throw malformed(); // 表单值取自同一份冻结快照，校验过的行必有条目；防御性兜底
    for (const key of BATCH_ROW_LABEL_KEYS) {
      if (open(sourceOf(key)) && Object.hasOwn(labels, key)) cell[key] = labels[key];
    }
    return cell;
  });
  return { ...values, offers };
}
