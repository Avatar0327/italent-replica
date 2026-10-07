import type { Dimension, DimensionType, NoteKey } from './api.js';
import { text } from './messages.js';

export interface ReferenceDraft {
  dimensionId: string;
  weight: number | null;
  target: number | null;
  displayOrder: number;
}
export interface CriterionDraft extends Record<string, unknown> {
  categoryId: string;
  name: string;
  enabled: boolean;
  abilityNote: string | null;
  potentialNote: string | null;
  experienceNote: string | null;
  achievementNote: string | null;
  dimensions: ReferenceDraft[];
}
export interface KnownDimension {
  readonly name: string;
  readonly type: DimensionType;
}

const NOTES: readonly NoteKey[] = ['abilityNote', 'potentialNote', 'experienceNote', 'achievementNote'];
const numberOrNull = (value: string) => (value === '' ? null : Number(value));

/** 人才标准表单：引用已启用的指标（TC-R4）；只有能力指标可填权重与目标（TC-R3，服务端同样校验）。 */
export function CriterionForm({
  value,
  categories,
  known,
  candidates,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: CriterionDraft;
  categories: readonly { id: string; name: string }[];
  known: ReadonlyMap<string, KnownDimension>;
  candidates: readonly Dimension[];
  busy: boolean;
  onChange: (value: CriterionDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<CriterionDraft>) => onChange({ ...value, ...patch });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {text.criterionCategory}
          <select required value={value.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="" />
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.name}
          <input required maxLength={200} value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {text.enabled}
        </label>
        {NOTES.map((key) => (
          <label key={key}>
            {text.notes[key]}
            <textarea
              maxLength={4000}
              value={value[key] ?? ''}
              onChange={(e) => set({ [key]: e.target.value || null })}
            />
          </label>
        ))}
        <References value={value} known={known} candidates={candidates} set={set} />
        <button type="submit">{text.save}</button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}

/** 标准里的指标：只引用、不复制；非能力指标的权重与目标输入框不可用（TC-R3）。 */
function References({
  value,
  known,
  candidates,
  set,
}: {
  value: CriterionDraft;
  known: ReadonlyMap<string, KnownDimension>;
  candidates: readonly Dimension[];
  set: (patch: Partial<CriterionDraft>) => void;
}) {
  const setReference = (index: number, patch: Partial<ReferenceDraft>) =>
    set({ dimensions: value.dimensions.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const chosen = new Set(value.dimensions.map((item) => item.dimensionId));
  const add = (dimensionId: string) =>
    set({
      dimensions: [
        ...value.dimensions,
        { dimensionId, weight: null, target: null, displayOrder: value.dimensions.length + 1 },
      ],
    });
  return (
    <fieldset>
      <legend>{text.referenced}</legend>
      <table>
        <thead>
          <tr>
            <th>{text.name}</th>
            <th>{text.type}</th>
            <th>{text.weight}</th>
            <th>{text.target}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {value.dimensions.map((item, index) => (
            <ReferenceRow
              key={item.dimensionId}
              item={item}
              dimension={known.get(item.dimensionId)}
              onChange={(patch) => setReference(index, patch)}
              onRemove={() => set({ dimensions: value.dimensions.filter((_, i) => i !== index) })}
            />
          ))}
        </tbody>
      </table>
      <label>
        {text.addDimension}
        <select value="" onChange={(e) => e.target.value && add(e.target.value)}>
          <option value="">{text.chooseDimension}</option>
          {candidates
            .filter((item) => !chosen.has(item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{text.types[item.type]}）
              </option>
            ))}
        </select>
      </label>
    </fieldset>
  );
}

function ReferenceRow({
  item,
  dimension,
  onChange,
  onRemove,
}: {
  item: ReferenceDraft;
  dimension: KnownDimension | undefined;
  onChange: (patch: Partial<ReferenceDraft>) => void;
  onRemove: () => void;
}) {
  const ability = dimension?.type === 'ability';
  return (
    <tr>
      <td>{dimension?.name ?? item.dimensionId}</td>
      <td>{dimension ? text.types[dimension.type] : ''}</td>
      {(['weight', 'target'] as const).map((field) => (
        <td key={field}>
          <input
            type="number"
            min={0}
            max={field === 'weight' ? 100 : undefined}
            step="0.01"
            aria-label={text[field]}
            title={ability ? undefined : text.abilityOnly}
            disabled={!ability}
            value={item[field] ?? ''}
            onChange={(e) => onChange({ [field]: numberOrNull(e.target.value) })}
          />
        </td>
      ))}
      <td>
        <button type="button" onClick={onRemove}>
          {text.remove}
        </button>
      </td>
    </tr>
  );
}
