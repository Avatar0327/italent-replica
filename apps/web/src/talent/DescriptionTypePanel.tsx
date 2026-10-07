import { useState } from 'react';
import type { DescriptionType } from './api.js';
import { changedFields } from './changes.js';
import { text } from './messages.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

interface Draft {
  readonly original: DescriptionType | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
}

const pick = ({ name, enabled, displayOrder }: DescriptionType) => ({ name, enabled, displayOrder });

/**
 * 发展建议类型（DEC-281④）：发展建议“类型”下拉的数据源，租户可配置；开通时预置样本“行动建议”（完整选项未取证 🟡）。
 * 停用的类型不能新选用，已有发展建议保留；被使用的类型不能删除。没有组织字段：只认看全部或创建人（DEC-121）。
 */
export function DescriptionTypePanel({ tenantId }: { tenantId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const list = useList<DescriptionType>(tenantId, 'description-types', write.setError);
  const save = (value: Draft) => {
    const { original, ...fields } = value;
    write.mutate({
      path: original ? `description-types/${original.id}` : 'description-types',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: original ? changedFields(pick(original), fields) : fields,
    });
  };
  return (
    <section aria-busy={write.busy}>
      <button
        disabled={write.locked}
        onClick={() => setDraft({ original: null, name: '', enabled: true, displayOrder: 0 })}
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <ul>
        {list.items.map((item) => (
          <li key={item.id}>
            {item.name}
            {!item.enabled && `（${text.disabled}）`}
            <button disabled={write.locked} onClick={() => setDraft({ ...pick(item), original: item })}>
              {text.edit}
            </button>
            <button
              disabled={write.locked}
              onClick={() =>
                window.confirm(text.confirmDelete) &&
                write.mutate({ path: `description-types/${item.id}`, method: 'DELETE', revision: item.revision })
              }
            >
              {text.delete}
            </button>
          </li>
        ))}
      </ul>
      <Pager list={list} locked={write.locked} />
      {draft && (
        <TypeForm
          draft={draft}
          busy={write.locked}
          onChange={setDraft}
          onSubmit={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}

function TypeForm({
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
            maxLength={50}
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
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
