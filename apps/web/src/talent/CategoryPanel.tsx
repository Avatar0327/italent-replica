import { useState } from 'react';
import type { Category, OwnerOrg } from './api.js';
import { changedFields } from './changes.js';
import { AccessNotice, Editable, editableBody, useFormAccess, type FormAccessState } from './FormAccess.js';
import { text } from './messages.js';
import { ownerOrgBody, OwnerUnitField, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';
import { candidatesBlocked, type CandidateState } from './useCandidates.js';

interface Draft {
  readonly original: Category | null;
  readonly name: string;
  readonly displayOrder: number;
  readonly ownerOrgId: string;
}

/**
 * 人才标准分类：所属人 / 所属管理单元由系统填写（DEC-294③，多个授权管理单元时新建可选，建后不可改）；
 * 分类下还有人才标准时不能删除（DEC-281⑦）。
 */
export function CategoryPanel({ tenantId }: { tenantId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const list = useList<Category>(tenantId, 'criterion-categories', write.setError);
  const owners = useOwnerOrgs(tenantId, 'criterionCategory');
  const access = useFormAccess(tenantId, 'criterionCategory', draft?.original);
  const blocked = access.blocked || (!!draft && !draft.original && candidatesBlocked(owners));
  const save = (value: Draft) => {
    if (blocked) return;
    const { original, ownerOrgId, ...fields } = value;
    write.mutate({
      path: original ? `criterion-categories/${original.id}` : 'criterion-categories',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: original
        ? editableBody(
            changedFields({ name: original.name, displayOrder: original.displayOrder }, fields),
            access.access,
          )
        : { ...editableBody(fields, access.access), ...ownerOrgBody(owners.items, ownerOrgId) },
    });
  };
  const edit = (item: Category) =>
    setDraft({ original: item, name: item.name, displayOrder: item.displayOrder, ownerOrgId: '' });
  return (
    <section aria-busy={write.busy}>
      <button
        disabled={write.locked}
        onClick={() => setDraft({ original: null, name: '', displayOrder: 0, ownerOrgId: '' })}
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <ul>
        {list.items.map((item) => (
          <li key={item.id}>
            {item.name}
            <button disabled={write.locked} onClick={() => edit(item)}>
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
        <CategoryForm
          draft={draft}
          owners={owners}
          access={access}
          blocked={blocked}
          busy={write.locked}
          onChange={setDraft}
          onSubmit={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}

function CategoryForm({
  draft,
  owners,
  access,
  blocked,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  owners: CandidateState<OwnerOrg>;
  access: FormAccessState;
  blocked: boolean;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <AccessNotice state={access} />
        <Editable access={access.access} field="name">
          <label>
            {text.name}
            <input
              required={access.access.requiredFields.includes('name')}
              maxLength={200}
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
          </label>
        </Editable>
        <OwnerUnitField
          editing={!!draft.original}
          value={draft.ownerOrgId}
          options={owners.items}
          state={owners}
          onChange={(ownerOrgId) => onChange({ ...draft, ownerOrgId })}
        />
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
