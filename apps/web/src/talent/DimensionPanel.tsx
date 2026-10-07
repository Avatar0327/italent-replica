import { useEffect, useMemo, useState } from 'react';
import { listAll, type DescriptionType, type Dimension, type DimensionCategory, type Library } from './api.js';
import { changedFields } from './changes.js';
import { DimensionForm, draftOf, type DimensionChoices, type DimensionEditor } from './DimensionForm.js';
import { text } from './messages.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

/**
 * 指标：编码、名称、定义、分类、顺序、启用，以及等级描述 / 行为描述 / 发展建议 / 面试问题。
 * 编码与名称在库内唯一（DEC-281⑤）；改了指标内容，引用它的人才标准立即显示新内容（TC-R2）；
 * 被引用的指标可以停用、不能删除（DEC-281⑧，TC-R5）。
 */
export function DimensionPanel({ tenantId }: { tenantId: string }) {
  const [libraryId, setLibraryId] = useState('');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [editor, setEditor] = useState<DimensionEditor | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setEditor(null);
    list.reload();
  });
  const path = `dimensions${libraryId ? `?libraryId=${libraryId}` : ''}`;
  const list = useList<Dimension>(tenantId, path, write.setError);
  useEffect(() => {
    void listAll<Library>(tenantId, 'libraries')
      .then(setLibraries)
      .catch((cause: unknown) => write.setError(String(cause)));
  }, [tenantId, write.setError]);
  const choices = useDimensionChoices(tenantId, editor, write.setError);
  const libraryName = (id: string) => libraries.find((item) => item.id === id)?.name ?? '';
  const save = () => {
    if (!editor) return;
    const { original, value } = editor;
    write.mutate(
      original
        ? {
            path: `dimensions/${original.id}`,
            method: 'PATCH',
            revision: original.revision,
            body: changedFields(draftOf(original), value),
          }
        : { path: 'dimensions', method: 'POST', revision: 0, body: { ...value, libraryId: editor.libraryId } },
    );
  };
  return (
    <section aria-busy={write.busy}>
      <LibraryFilter libraries={libraries} value={libraryId} onChange={setLibraryId} />
      <button
        disabled={write.locked || !libraries.length}
        onClick={() => setEditor({ original: null, libraryId: libraryId || libraries[0]!.id, value: draftOf(null) })}
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <DimensionTable
        items={list.items}
        libraryName={libraryName}
        locked={write.locked}
        onEdit={(item) => setEditor({ original: item, libraryId: item.libraryId, value: draftOf(item) })}
        onDelete={(item) => write.mutate({ path: `dimensions/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {editor && (
        <DimensionForm
          editor={editor}
          libraries={libraries}
          choices={choices}
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
          {item.name}（{text.types[item.type]}）
        </option>
      ))}
    </select>
  );
}

/** 编辑时的选项：所选指标库的分类、启用的发展建议类型（另补上指标已用、但已停用的类型，保留原行）。 */
function useDimensionChoices(
  tenantId: string,
  editor: DimensionEditor | null,
  onError: (message: string) => void,
): DimensionChoices {
  const [categories, setCategories] = useState<DimensionCategory[]>([]);
  const [types, setTypes] = useState<DescriptionType[]>([]);
  const libraryId = editor?.libraryId;
  useEffect(() => {
    if (!libraryId) return;
    void listAll<DimensionCategory>(tenantId, `dimension-categories?libraryId=${libraryId}`)
      .then(setCategories)
      .catch((cause: unknown) => onError(String(cause)));
  }, [tenantId, libraryId, onError]);
  const editing = editor !== null;
  useEffect(() => {
    if (!editing) return;
    void listAll<DescriptionType>(tenantId, 'candidates/description-types')
      .then(setTypes)
      .catch((cause: unknown) => onError(String(cause)));
  }, [tenantId, editing, onError]);
  const original = editor?.original;
  return useMemo(() => {
    const known = new Map(types.map((item) => [item.id, item]));
    for (const row of original?.suggestions ?? []) {
      if (!known.has(row.typeId)) {
        const kept = { id: row.typeId, revision: 0, name: row.typeName ?? row.typeId, enabled: false, displayOrder: 0 };
        known.set(row.typeId, kept);
      }
    }
    return { categories, types: [...known.values()] };
  }, [categories, types, original]);
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
