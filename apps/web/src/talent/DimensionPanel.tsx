import { useMemo, useState } from 'react';
import type { DescriptionType, Dimension, DimensionCategory, Library } from './api.js';
import { changedFields } from './changes.js';
import { DimensionForm, draftOf, type DimensionChoices, type DimensionEditor } from './DimensionForm.js';
import { editableBody, useFormAccess } from './FormAccess.js';
import { text } from './messages.js';
import { ownerOrgBody, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { FreshEditNotice, useFreshEditor } from './useFreshEditor.js';
import { useTalentWrite } from './useTalentWrite.js';
import { candidateLabel, CandidateNotice, candidatesBlocked, useCandidates } from './useCandidates.js';

const editorOf = (item: Dimension): DimensionEditor => ({
  original: item,
  libraryId: item.libraryId ?? '',
  ownerOrgId: '',
  value: draftOf(item),
});

/**
 * 指标：编码、名称、定义、分类、顺序、启用，以及等级描述 / 行为描述 / 发展建议 / 面试问题。
 * 编码与名称在库内唯一（DEC-281⑤）；改了指标内容，引用它的人才标准立即显示新内容（TC-R2）；
 * 被引用的指标可以停用、不能删除（DEC-281⑧，TC-R5）。所属人 / 所属管理单元由系统按创建人填写（DEC-294③）。
 */
export function DimensionPanel({ tenantId }: { tenantId: string }) {
  const [libraryId, setLibraryId] = useState('');
  const libraryChoices = useCandidates<Library>(tenantId, 'libraries');
  const libraries = libraryChoices.items ?? [];
  const fresh = useFreshEditor(tenantId, 'dimensions', editorOf);
  const { editor, setEditor } = fresh;
  const write = useTalentWrite(tenantId, () => {
    setEditor(null);
    list.reload();
  });
  const path = `dimensions${libraryId ? `?libraryId=${libraryId}` : ''}`;
  const list = useList<Dimension>(tenantId, path, write.setError);
  const choices = useDimensionChoices(tenantId, editor);
  const access = useFormAccess(tenantId, 'dimension', editor?.original, editor?.original);
  const blocked =
    access.blocked ||
    (!!editor && !editor.original && (candidatesBlocked(choices.ownerState) || candidatesBlocked(libraryChoices)));
  const libraryName = (id: string) => libraries.find((item) => item.id === id)?.name ?? '';
  const save = () => {
    if (!editor || blocked) return;
    const { original, value } = editor;
    write.mutate(
      original
        ? {
            path: `dimensions/${original.id}`,
            method: 'PATCH',
            revision: original.revision,
            body: editableBody(changedFields(draftOf(original), value), access.access),
          }
        : {
            path: 'dimensions',
            method: 'POST',
            revision: 0,
            body: {
              ...editableBody({ ...value, libraryId: editor.libraryId }, access.access),
              ...ownerOrgBody(choices.owners, editor.ownerOrgId),
            },
          },
    );
  };
  return (
    <section aria-busy={write.busy || fresh.loading}>
      <CandidateNotice state={libraryChoices} label={text.library} />
      <LibraryFilter libraries={libraries} value={libraryId} onChange={setLibraryId} />
      <button
        disabled={write.locked || !libraries.length}
        onClick={() =>
          setEditor({ original: null, libraryId: libraryId || libraries[0]!.id, ownerOrgId: '', value: draftOf(null) })
        }
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <FreshEditNotice state={fresh} />
      <DimensionTable
        items={list.items}
        libraryName={libraryName}
        locked={write.locked}
        onEdit={(item) => fresh.edit(item.id)}
        onDelete={(item) => write.mutate({ path: `dimensions/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {editor && (
        <DimensionForm
          editor={editor}
          libraries={libraries}
          choices={choices}
          access={access}
          blocked={blocked}
          libraryChoices={libraryChoices}
          busy={write.locked}
          onChange={setEditor}
          onSubmit={save}
          onCancel={() => setEditor(null)}
        />
      )}
    </section>
  );
}

function LibraryFilter({
  libraries,
  value,
  onChange,
}: {
  libraries: readonly Library[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select aria-label={text.library} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{text.allLibraries}</option>
      {libraries.map((item) => (
        <option key={item.id} value={item.id}>
          {candidateLabel(item)}
        </option>
      ))}
    </select>
  );
}

/**
 * 编辑时的选项：所选指标库的分类、启用的发展建议类型，以及按行保留的已停用类型——只给原本就是该类型的那一行
 * （按建议行 ID，DEC-297②）；新建时的授权管理单元（DEC-294③）。
 */
function useDimensionChoices(tenantId: string, editor: DimensionEditor | null): DimensionChoices {
  const libraryId = editor?.libraryId;
  const loadedCategories = useCandidates<DimensionCategory>(
    tenantId,
    `dimension-categories?libraryId=${libraryId ?? ''}`,
    !!libraryId,
  );
  const categoryState =
    editor && !libraryId
      ? { items: undefined, status: 'error' as const, error: text.missingLibrary }
      : loadedCategories;
  const typeState = useCandidates<DescriptionType>(tenantId, 'candidates/description-types', editor !== null);
  const ownerState = useOwnerOrgs(tenantId, 'dimension');
  const original = editor?.original;
  return useMemo(() => {
    const enabled = new Set(typeState.items?.map((item) => item.id));
    const retained = new Map<string, { value: string; label: string }>();
    for (const row of original?.suggestions ?? []) {
      if (row.id && !enabled.has(row.typeId)) {
        retained.set(row.id, { value: row.typeId, label: row.typeName ?? row.typeId });
      }
    }
    return {
      categories: categoryState.items ?? [],
      types: typeState.items ?? [],
      retained,
      owners: ownerState.items,
      ownerState,
      categoryState,
      typeState,
    };
  }, [categoryState, typeState, original, ownerState]);
}

function DimensionTable({
  items,
  libraryName,
  locked,
  onEdit,
  onDelete,
}: {
  items: readonly Dimension[];
  libraryName: (id: string) => string;
  locked: boolean;
  onEdit: (item: Dimension) => void;
  onDelete: (item: Dimension) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          {[text.code, text.name, text.type, text.library, text.category, text.definition, text.enabled, ''].map(
            (label, i) => (
              <th key={i}>{label}</th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.code}</td>
            <td>{item.name}</td>
            <td>{text.types[item.type]}</td>
            <td>{libraryName(item.libraryId)}</td>
            <td>{item.categoryName}</td>
            <td>{item.definition}</td>
            <td>{item.enabled ? '✓' : text.disabled}</td>
            <td>
              <button disabled={locked} onClick={() => onEdit(item)}>
                {text.edit}
              </button>
              <button disabled={locked} onClick={() => window.confirm(text.confirmDelete) && onDelete(item)}>
                {text.delete}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
