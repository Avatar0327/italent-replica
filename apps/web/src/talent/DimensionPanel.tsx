import { useEffect, useState } from 'react';
import { listAll, type Dimension, type Library } from './api.js';
import { changedFields } from './changes.js';
import { DimensionForm, draftOf, type DimensionEditor } from './DimensionForm.js';
import { text } from './messages.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

/**
 * 指标：编码、名称、定义、分类、顺序、启用，以及等级描述 / 行为描述 / 发展建议 / 面试问题。
 * 改了指标内容，引用它的人才标准立即显示新内容（TC-R2）；被引用的指标不能删除（TC-R5）。
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
        locked={write.locked}
        onEdit={(item) => setEditor({ original: item, libraryId: item.libraryId, value: draftOf(item) })}
        onDelete={(item) => write.mutate({ path: `dimensions/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {editor && (
        <DimensionForm
          editor={editor}
          libraries={libraries}
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

function DimensionTable({
  items,
  locked,
  onEdit,
  onDelete,
}: {
  items: readonly Dimension[];
  locked: boolean;
  onEdit: (item: Dimension) => void;
  onDelete: (item: Dimension) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          {[text.code, text.name, text.type, text.library, text.definition, text.enabled, ''].map((label, i) => (
            <th key={i}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.code}</td>
            <td>{item.name}</td>
            <td>{text.types[item.type]}</td>
            <td>
              {item.libraryName}
              {!item.libraryEnabled && `（${text.libraryDisabled}）`}
            </td>
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
