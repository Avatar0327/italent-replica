import type { Behavior, Dimension, Grade, Library, Question, Suggestion } from './api.js';
import { text } from './messages.js';
import { RowsEditor } from './RowsEditor.js';

export interface DimensionDraft extends Record<string, unknown> {
  code: string;
  name: string;
  definition: string | null;
  category: string | null;
  displayOrder: number;
  enabled: boolean;
  grades: Grade[];
  behaviors: Behavior[];
  suggestions: Suggestion[];
  questions: Question[];
}
export interface DimensionEditor {
  readonly original: Dimension | null;
  readonly libraryId: string;
  readonly value: DimensionDraft;
}

export const draftOf = (item: Dimension | null): DimensionDraft => ({
  code: item?.code ?? '',
  name: item?.name ?? '',
  definition: item?.definition ?? null,
  category: item?.category ?? null,
  displayOrder: item?.displayOrder ?? 0,
  enabled: item?.enabled ?? true,
  grades: item?.grades ?? [],
  behaviors: item?.behaviors ?? [],
  suggestions: item?.suggestions ?? [],
  questions: item?.questions ?? [],
});

/** 指标表单：所属指标库只在新建时选择，之后不可修改（类型随指标库）。 */
export function DimensionForm({
  editor,
  libraries,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  editor: DimensionEditor;
  libraries: readonly Library[];
  busy: boolean;
  onChange: (editor: DimensionEditor) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const value = editor.value;
  const set = (patch: Partial<DimensionDraft>) => onChange({ ...editor, value: { ...value, ...patch } });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {text.library}
          <select
            value={editor.libraryId}
            disabled={!!editor.original}
            onChange={(event) => onChange({ ...editor, libraryId: event.target.value })}
          >
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{text.types[item.type]}）
              </option>
            ))}
          </select>
        </label>
        <BasicFields value={value} set={set} />
        <DetailEditors value={value} set={set} />
        <button type="submit">{text.save}</button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}

function BasicFields({ value, set }: { value: DimensionDraft; set: (patch: Partial<DimensionDraft>) => void }) {
  return (
    <>
      <label>
        {text.code}
        <input required maxLength={100} value={value.code} onChange={(e) => set({ code: e.target.value })} />
      </label>
      <label>
        {text.name}
        <input required maxLength={200} value={value.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        {text.definition}
        <textarea
          maxLength={4000}
          value={value.definition ?? ''}
          onChange={(e) => set({ definition: e.target.value || null })}
        />
      </label>
      <label>
        {text.category}
        <input
          maxLength={200}
          value={value.category ?? ''}
          onChange={(e) => set({ category: e.target.value || null })}
        />
      </label>
      <label>
        {text.displayOrder}
        <input
          type="number"
          min={0}
          value={value.displayOrder}
          onChange={(e) => set({ displayOrder: Number(e.target.value) })}
        />
      </label>
      <label>
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {text.enabled}
      </label>
    </>
  );
}

type Rows<T> = (T & Record<string, unknown>)[];

/** 等级描述 / 行为描述 / 发展建议 / 面试问题：各自整组编辑、整组提交。 */
function DetailEditors({ value, set }: { value: DimensionDraft; set: (patch: Partial<DimensionDraft>) => void }) {
  return (
    <>
      <RowsEditor<Grade & Record<string, unknown>>
        legend={text.grades}
        columns={[
          { key: 'gradeOrder', label: text.gradeOrder, kind: 'number', required: true },
          { key: 'alias', label: text.alias },
          { key: 'description', label: text.description, kind: 'textarea' },
        ]}
        rows={value.grades as Rows<Grade>}
        blank={() => ({ gradeOrder: value.grades.length + 1, alias: null, description: null })}
        onChange={(grades) => set({ grades })}
      />
      <RowsEditor<Behavior & Record<string, unknown>>
        legend={text.behaviors}
        columns={[
          { key: 'description', label: text.description, kind: 'textarea', required: true },
          { key: 'keyPoints', label: text.keyPoints, kind: 'textarea' },
        ]}
        rows={value.behaviors as Rows<Behavior>}
        blank={() => ({ description: '', keyPoints: null })}
        onChange={(behaviors) => set({ behaviors })}
      />
      <RowsEditor<Suggestion & Record<string, unknown>>
        legend={text.suggestions}
        columns={[
          { key: 'suggestionType', label: text.suggestionType },
          { key: 'description', label: text.description, kind: 'textarea', required: true },
        ]}
        rows={value.suggestions as Rows<Suggestion>}
        blank={() => ({ suggestionType: null, description: '' })}
        onChange={(suggestions) => set({ suggestions })}
      />
      <RowsEditor<Question & Record<string, unknown>>
        legend={text.questions}
        columns={[
          { key: 'question', label: text.question, kind: 'textarea', required: true },
          { key: 'keyPoints', label: text.keyPoints, kind: 'textarea' },
        ]}
        rows={value.questions as Rows<Question>}
        blank={() => ({ question: '', keyPoints: null })}
        onChange={(questions) => set({ questions })}
      />
    </>
  );
}
