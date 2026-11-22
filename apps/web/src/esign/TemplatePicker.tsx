// F-481 §8.1：签署模板多选（调动表单与补发弹窗共用）。原生多选框 + “全选”，提交顺序 = 下拉顺序；
// 选项来自后端 template-options（只列启用模板，按顺序号）；读不到、为空时说明原因，由调用方阻止提交“是”。
import { useRead } from '../contracts/useRead.js';
import { rejectionMessage } from '../foundation/client.js';
import { m } from './messages.js';

export type TemplateOption = { id: string; name: string };
export type TemplateOptions = { items?: TemplateOption[]; error?: unknown; loading: boolean; refresh?(): void };

const isOption = (raw: unknown): raw is TemplateOption => {
  const item = raw as Partial<TemplateOption> | null;
  return !!item && typeof item.id === 'string' && item.id !== '' && typeof item.name === 'string';
};
export function parseTemplateOptions(raw: unknown): TemplateOption[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isOption)) throw new Error(m.invalidList);
  return items;
}
/** path 为 null 时不读（字段不可见、未选“是”、弹窗未打开）。 */
export function useTemplateOptions(path: string | null): TemplateOptions {
  const read = useRead<unknown>(path);
  try {
    const items = read.data === undefined ? undefined : parseTemplateOptions(read.data);
    const base = { loading: read.loading, refresh: read.refresh };
    return { ...base, ...(items ? { items } : {}), ...(read.error ? { error: read.error } : {}) };
  } catch (error) {
    return { error, loading: false, refresh: read.refresh };
  }
}
/** 选中的模板里仍在选项中的部分（按下拉顺序）；为空表示不能提交。 */
export const chosenTemplates = (options: TemplateOptions, value: readonly string[]) =>
  (options.items ?? []).filter((item) => value.includes(item.id)).map((item) => item.id);

export function TemplatePicker(props: {
  options: TemplateOptions;
  value: readonly string[];
  disabled?: boolean;
  emptyText?: string;
  max?: number;
  onChange(ids: string[]): void;
}) {
  const { options, value, disabled, emptyText, max, onChange } = props;
  if (options.error) return <p role="alert">{m.picker.failed(rejectionMessage(options.error))}</p>;
  if (!options.items) return <p>{m.picker.loading}</p>;
  if (!options.items.length) return <p role="note">{emptyText ?? m.picker.empty}</p>;
  const ids = options.items.map((item) => item.id);
  const all = ids.every((id) => value.includes(id));
  return (
    <div className="esign-template-picker">
      <label>
        <span>
          <span className="esign-required">*</span>
          {m.picker.label}
        </span>
        <select
          name="esignTemplateIds"
          multiple
          disabled={disabled}
          value={[...value]}
          // 按 options[].selected 取：happy-dom 的 selectedOptions 取消选中后不刷新，浏览器两者一致。
          onChange={(event) =>
            onChange(Array.from(event.target.options).flatMap((option) => (option.selected ? [option.value] : [])))
          }
        >
          {options.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          name="esignTemplateAll"
          disabled={disabled}
          checked={all}
          onChange={() => onChange(all ? [] : ids)}
        />
        {m.picker.all}
      </label>
      {max !== undefined && chosenTemplates(options, value).length > max && <p role="alert">{m.picker.tooMany(max)}</p>}
    </div>
  );
}
