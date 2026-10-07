import { useState } from 'react';
import { DIMENSION_TYPES, type DimensionType, type Library } from './api.js';
import { changedFields } from './changes.js';
import { text } from './messages.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

interface Draft {
  readonly original: Library | null;
  readonly name: string;
  readonly type: DimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
}

const pick = ({ name, type, enabled, displayOrder }: Library) => ({ name, type, enabled, displayOrder });

/** 指标库：按 能力 / 潜力 / 经历 三类建立（TC-R1）；类型创建后不可修改；还有指标的指标库不能删除（TC-R5）。 */
export function LibraryPanel({ tenantId }: { tenantId: string }) {
  const [type, setType] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const list = useList<Library>(tenantId, `libraries${type ? `?type=${type}` : ''}`, write.setError);
  const save = () => {
    if (!draft) return;
    const { original, type: draftType, ...fields } = draft;
    write.mutate({
      path: original ? `libraries/${original.id}` : 'libraries',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: original ? changedFields(pick(original), fields) : { ...fields, type: draftType },
    });
  };
  return (
    <section aria-busy={write.busy}>
      <select aria-label={text.type} value={type} onChange={(event) => setType(event.target.value)}>
        <option value="">{text.allTypes}</option>
        {DIMENSION_TYPES.map((item) => (
          <option key={item} value={item}>
            {text.types[item]}
          </option>
        ))}
      </select>
      <button
        disabled={write.locked}
        onClick={() => setDraft({ original: null, name: '', type: 'ability', enabled: true, displayOrder: 0 })}
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <LibraryTable
        items={list.items}
        locked={write.locked}
        onEdit={(item) => setDraft({ ...pick(item), original: item })}
        onDelete={(item) => write.mutate({ path: `libraries/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {draft && (
        <LibraryForm
          draft={draft}
          busy={write.locked}
          onChange={setDraft}
          onSubmit={save}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}

function LibraryTable({
  items,
  locked,
  onEdit,
  onDelete,
}: {
  items: readonly Library[];
  locked: boolean;
  onEdit: (item: Library) => void;
  onDelete: (item: Library) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{text.name}</th>
          <th>{text.type}</th>
          <th>{text.enabled}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.name}</td>
            <td>{text.types[item.type]}</td>
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

function LibraryForm({
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {text.name}
          <input
            required
            maxLength={200}
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          {text.type}
          <select
            value={draft.type}
            disabled={!!draft.original}
            onChange={(event) => onChange({ ...draft, type: event.target.value as DimensionType })}
          >
            {DIMENSION_TYPES.map((item) => (
              <option key={item} value={item}>
                {text.types[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.displayOrder}
          <input
            type="number"
            min={0}
            value={draft.displayOrder}
            onChange={(event) => onChange({ ...draft, displayOrder: Number(event.target.value) })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          {text.enabled}
        </label>
        <button type="submit">{text.save}</button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}
