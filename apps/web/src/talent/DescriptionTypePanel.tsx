import { useState } from 'react';
import type { DescriptionType } from './api.js';
import { changedFields } from './changes.js';
import { AccessNotice, Editable, editableBody, useFormAccess, type FormAccessState } from './FormAccess.js';
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
  const access = useFormAccess(tenantId, 'descriptionType', draft?.original);
  const save = (value: Draft) => {
    if (access.blocked) return;
    const { original, ...fields } = value;
    write.mutate({
      path: original ? `description-types/${original.id}` : 'description-types',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: editableBody(original ? changedFields(pick(original), fields) : fields, access.access),
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
          access={access}
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
  access,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  access: FormAccessState;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!access.blocked) onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <AccessNotice state={access} />
        <Editable access={access.access} field="name">
          <label>
            {text.name}
            <input
              required={access.access.requiredFields.includes('name')}
              maxLength={50}
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
          </label>
        </Editable>
        <Editable access={access.access} field="displayOrder">
          <label>
            {text.displayOrder}
            <input
              type="number"
              min={0}
              value={draft.displayOrder}
              onChange={(event) => onChange({ ...draft, displayOrder: Number(event.target.value) })}
            />
          </label>
        </Editable>
        <Editable access={access.access} field="enabled">
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
            />
            {text.enabled}
          </label>
        </Editable>
        <button type="submit" disabled={access.blocked}>
          {text.save}
        </button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}
