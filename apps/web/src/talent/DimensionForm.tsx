import type {
  Behavior,
  DescriptionType,
  Dimension,
  DimensionCategory,
  Grade,
  Library,
  OwnerOrg,
  Question,
  Suggestion,
} from './api.js';
import { AccessNotice, Editable, type FormAccess, type FormAccessState } from './FormAccess.js';
import { EnabledField, NameField, OrderField } from './FormFields.js';
import { text } from './messages.js';
import { OwnerUnitField } from './OwnerOrgSelect.js';
import { RowsEditor } from './RowsEditor.js';
import { candidateLabel, CandidateNotice, candidatesBlocked, type CandidateState } from './useCandidates.js';

type SuggestionDraft = Omit<Suggestion, 'typeName'>;
export interface DimensionDraft extends Record<string, unknown> {
  code: string;
  name: string;
  definition: string | null;
  categoryId: string | null;
  displayOrder: number;
  enabled: boolean;
  grades: Grade[];
  behaviors: Behavior[];
  suggestions: SuggestionDraft[];
  questions: Question[];
}
export interface DimensionEditor {
  readonly original: Dimension | null;
  readonly libraryId: string;
  /** 新建时从多个授权管理单元里选的那一个（DEC-294 补充）；只有一个或编辑时不用。 */
  readonly ownerOrgId: string;
  readonly value: DimensionDraft;
}

export const draftOf = (item: Dimension | null): DimensionDraft => ({
  code: item?.code ?? '',
  name: item?.name ?? '',
  definition: item?.definition ?? null,
  categoryId: item?.categoryId ?? null,
  displayOrder: item?.displayOrder ?? 0,
  enabled: item?.enabled ?? true,
  grades: item?.grades ?? [],
  behaviors: item?.behaviors ?? [],
  // 类型名称是查找字段的显示值，不随表单提交；行 ID 带回表示保留这一行（DEC-297②）
  suggestions: (item?.suggestions ?? []).map(({ id, typeId, description, displayOrder }) => ({
    id,
    typeId,
    description,
    displayOrder,
  })),
  questions: item?.questions ?? [],
});

type Option = { readonly value: string; readonly label: string };
/** 选项：本指标库的分类、启用的发展建议类型，以及按行保留的已停用类型（建议行 ID → 原类型）。 */
export interface DimensionChoices {
  readonly categories: readonly DimensionCategory[];
  readonly types: readonly DescriptionType[];
  readonly retained: ReadonlyMap<string, Option>;
  readonly owners: readonly OwnerOrg[] | undefined;
  readonly ownerState: CandidateState<OwnerOrg>;
  readonly categoryState: CandidateState<DimensionCategory>;
  readonly typeState: CandidateState<DescriptionType>;
}

/** 指标表单：所属指标库只在新建时选择，编码建后只读（DEC-281⑤⑥）；类型随指标库。 */
export function DimensionForm({
  editor,
  libraries,
  choices,
  busy,
  access,
  blocked,
  libraryChoices,
  onChange,
  onSubmit,
  onCancel,
}: {
  editor: DimensionEditor;
  libraries: readonly Library[];
  choices: DimensionChoices;
  busy: boolean;
  access: FormAccessState;
  blocked: boolean;
  libraryChoices: CandidateState<Library>;
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
        if (!blocked) onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <AccessNotice state={access} />
        {!editor.original && (
          <Editable access={access.access} field="libraryId">
            <CandidateNotice state={libraryChoices} label={text.library} />
            <label>
              {text.library}
              <select
                value={editor.libraryId}
                disabled={!!editor.original}
                onChange={(event) => onChange({ ...editor, libraryId: event.target.value })}
              >
                {libraries.map((item) => (
                  <option key={item.id} value={item.id}>
                    {candidateLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </Editable>
        )}
        <OwnerUnitField
          editing={!!editor.original}
          value={editor.ownerOrgId}
          options={choices.owners}
          state={choices.ownerState}
          onChange={(ownerOrgId) => onChange({ ...editor, ownerOrgId })}
        />
        <BasicFields
          value={value}
          readOnlyCode={!!editor.original}
          choices={choices}
          access={access.access}
          set={set}
        />
        <DetailEditors value={value} choices={choices} access={access.access} set={set} />
        <button type="submit" disabled={blocked}>
          {text.save}
        </button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}

function BasicFields({
  value,
  readOnlyCode,
  choices,
  access,
  set,
}: {
  value: DimensionDraft;
  readOnlyCode: boolean;
  choices: DimensionChoices;
  access: FormAccess;
  set: (patch: Partial<DimensionDraft>) => void;
}) {
  return (
    <>
      {!readOnlyCode && (
        <Editable access={access} field="code">
          <label>
            {text.code}
            <input
              required={access.requiredFields.includes('code')}
              readOnly={readOnlyCode}
              maxLength={50}
              pattern="[A-Za-z][A-Za-z0-9_]*"
              value={value.code}
              onChange={(e) => set({ code: e.target.value })}
            />
          </label>
        </Editable>
      )}
      <NameField access={access} value={value.name} onChange={(name) => set({ name })} />
      <Editable access={access} field="definition">
        <label>
          {text.definition}
          <textarea
            maxLength={4000}
            value={value.definition ?? ''}
            onChange={(e) => set({ definition: e.target.value || null })}
          />
        </label>
      </Editable>
      <Editable access={access} field="categoryId">
        <CandidateNotice state={choices.categoryState} label={text.category} />
        <label>
          {text.category}
          <select
            disabled={choices.categoryState.status !== 'ready'}
            value={value.categoryId ?? ''}
            onChange={(e) => set({ categoryId: e.target.value || null })}
          >
            <option value="">{text.noCategory}</option>
            {value.categoryId && !choices.categories.some((item) => item.id === value.categoryId) && (
              <option value={value.categoryId}>{value.categoryId}</option>
            )}
            {choices.categories.map((item) => (
              <option key={item.id} value={item.id}>
                {candidateLabel(item)}
              </option>
            ))}
          </select>
        </label>
      </Editable>
      <OrderField
        access={access}
        min={0}
        value={value.displayOrder}
        onChange={(displayOrder) => set({ displayOrder })}
      />
      <EnabledField access={access} value={value.enabled} onChange={(enabled) => set({ enabled })} />
    </>
  );
}

type Rows<T> = (T & Record<string, unknown>)[];

/** 等级描述 / 行为描述 / 发展建议 / 面试问题：各自整组编辑、整组提交。 */
function DetailEditors({
  value,
  choices,
  access,
  set,
}: {
  value: DimensionDraft;
  choices: DimensionChoices;
  access: FormAccess;
  set: (patch: Partial<DimensionDraft>) => void;
}) {
  const enabled = choices.types.map((item) => ({ value: item.id, label: candidateLabel(item) }));
  // 停用的类型只出现在原本就是该类型的那一行（DEC-297②）；新增行只能选启用的类型
  const typeOptions = (row: SuggestionDraft) => {
    const kept = row.id ? choices.retained.get(row.id) : undefined;
    return kept ? [...enabled, kept] : enabled;
  };
  return (
    <>
      <Editable access={access} field="grades">
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
      </Editable>
      <Editable access={access} field="behaviors">
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
      </Editable>
      <Editable access={access} field="suggestions">
        <CandidateNotice state={choices.typeState} label={text.suggestionType} />
        <RowsEditor<SuggestionDraft & Record<string, unknown>>
          legend={text.suggestions}
          columns={[
            { key: 'displayOrder', label: text.presentOrder, kind: 'number', required: true },
            {
              key: 'typeId',
              label: text.suggestionType,
              kind: 'select',
              required: true,
              optionsFor: typeOptions,
            },
            { key: 'description', label: text.description, kind: 'textarea', required: true },
          ]}
          rows={value.suggestions as Rows<SuggestionDraft>}
          blank={() => ({ typeId: '', description: '', displayOrder: value.suggestions.length + 1 })}
          onChange={(suggestions) => set({ suggestions })}
          addDisabled={candidatesBlocked(choices.typeState)}
        />
      </Editable>
      <Editable access={access} field="questions">
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
      </Editable>
    </>
  );
}
