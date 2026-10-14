import { useState } from 'react';
import { DIMENSION_TYPES, type DimensionType, type Library, type OwnerOrg } from './api.js';
import { changedFields } from './changes.js';
import { AccessNotice, Editable, editableBody, useFormAccess, type FormAccessState } from './FormAccess.js';
import { EnabledField, NameField, OrderField } from './FormFields.js';
import { text } from './messages.js';
import { ownerOrgBody, OwnerUnitField, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { FreshEditNotice, readFields, useFreshEditor } from './useFreshEditor.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';
import { candidatesBlocked, type CandidateState } from './useCandidates.js';

interface Draft {
  readonly original: Library | null;
  readonly name?: string;
  readonly type?: DimensionType;
  readonly enabled?: boolean;
  readonly displayOrder?: number;
  readonly ownerOrgId: string;
}

const pick = (item: Library) => readFields(item, ['name', 'enabled', 'displayOrder']);
const editDraft = (item: Library): Draft => ({
  ...pick(item),
  ...readFields(item, ['type']),
  ownerOrgId: '',
  original: item,
});

/**
 * 指标库：按 能力 / 潜力 / 经历 三类建立（TC-R1）；类型建后不可修改（DEC-281⑥）；所属人 / 所属管理单元由系统填写，
 * 只在创建人有多个授权管理单元时新建可选（DEC-294③）；
 * 还有指标或分类的指标库不能删除（TC-R5）。
 */
export function LibraryPanel({ tenantId }: { tenantId: string }) {
  const [type, setType] = useState('');
  const fresh = useFreshEditor<Library, Draft>(tenantId, 'libraries', editDraft);
  const { editor: draft, setEditor: setDraft } = fresh;
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const list = useList<Library>(tenantId, `libraries${type ? `?type=${type}` : ''}`, write.setError);
  const owners = useOwnerOrgs(tenantId, 'library');
  const access = useFormAccess(tenantId, 'library', draft?.original, draft?.original);
  const blocked = access.blocked || (!!draft && !draft.original && candidatesBlocked(owners));
  const save = () => {
    if (!draft || blocked) return;
    const { original, type: draftType, ownerOrgId, ...fields } = draft;
    write.mutate({
      path: original ? `libraries/${original.id}` : 'libraries',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: original
        ? editableBody(changedFields(pick(original), fields), access.access)
        : { ...editableBody({ ...fields, type: draftType }, access.access), ...ownerOrgBody(owners.items, ownerOrgId) },
    });
  };
  const blank: Draft = { original: null, name: '', type: 'ability', enabled: true, displayOrder: 0, ownerOrgId: '' };
  return (
    <section aria-busy={write.busy || fresh.loading}>
      <select aria-label={text.type} value={type} onChange={(event) => setType(event.target.value)}>
        <option value="">{text.allTypes}</option>
        {DIMENSION_TYPES.map((item) => (
          <option key={item} value={item}>
            {text.types[item]}
          </option>
        ))}
      </select>
      <button disabled={write.locked} onClick={() => setDraft(blank)}>
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <FreshEditNotice state={fresh} />
      <LibraryTable
        items={list.items}
        locked={write.locked}
        onEdit={(item) => fresh.edit(item.id)}
        onDelete={(item) => write.mutate({ path: `libraries/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {draft && (
        <LibraryForm
          draft={draft}
          owners={owners}
          access={access}
          blocked={blocked}
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
        <NameField access={access.access} value={draft.name} onChange={(name) => onChange({ ...draft, name })} />
        {!draft.original && (
          <Editable access={access.access} field="type">
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
          </Editable>
        )}
        <OwnerUnitField
          editing={!!draft.original}
          value={draft.ownerOrgId}
          options={owners.items}
          state={owners}
          onChange={(ownerOrgId) => onChange({ ...draft, ownerOrgId })}
        />
        <OrderField
          access={access.access}
          value={draft.displayOrder}
          min={0}
          onChange={(displayOrder) => onChange({ ...draft, displayOrder })}
        />
        <EnabledField
          access={access.access}
          value={draft.enabled}
          onChange={(enabled) => onChange({ ...draft, enabled })}
        />
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
