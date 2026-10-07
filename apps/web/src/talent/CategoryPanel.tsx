import { useState } from 'react';
import type { Category } from './api.js';
import { changedFields } from './changes.js';
import { text } from './messages.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

/** 人才标准分类：分类下还有人才标准时不能删除。 */
export function CategoryPanel({ tenantId }: { tenantId: string }) {
  const [draft, setDraft] = useState<{ original: Category | null; name: string; displayOrder: number } | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const list = useList<Category>(tenantId, 'criterion-categories', write.setError);
  return (
    <section aria-busy={write.busy}>
      <button disabled={write.locked} onClick={() => setDraft({ original: null, name: '', displayOrder: 0 })}>
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <ul>
        {list.items.map((item) => (
          <li key={item.id}>
            {item.name}
            <button
              disabled={write.locked}
              onClick={() => setDraft({ original: item, name: item.name, displayOrder: item.displayOrder })}
            >
              {text.edit}
            </button>
            <button
              disabled={write.locked}
              onClick={() =>
                window.confirm(text.confirmDelete) &&
                write.mutate({ path: `criterion-categories/${item.id}`, method: 'DELETE', revision: item.revision })
              }
            >
              {text.delete}
            </button>
          </li>
        ))}
      </ul>
      <Pager list={list} locked={write.locked} />
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const { original, ...fields } = draft;
            write.mutate({
              path: original ? `criterion-categories/${original.id}` : 'criterion-categories',
              method: original ? 'PATCH' : 'POST',
              revision: original?.revision ?? 0,
              body: original
                ? changedFields({ name: original.name, displayOrder: original.displayOrder }, fields)
                : fields,
            });
          }}
        >
          <fieldset disabled={write.locked}>
            <label>
              {text.name}
              <input
                required
                maxLength={200}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              {text.displayOrder}
              <input
                type="number"
                min={0}
                value={draft.displayOrder}
                onChange={(event) => setDraft({ ...draft, displayOrder: Number(event.target.value) })}
              />
            </label>
            <button type="submit">{text.save}</button>
            <button type="button" onClick={() => setDraft(null)}>
              {text.cancel}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
