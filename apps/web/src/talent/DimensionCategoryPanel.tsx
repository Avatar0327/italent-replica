import { useEffect, useState } from 'react';
import { listAll, type DimensionCategory, type Library, type OwnerOrg } from './api.js';
import { changedFields } from './changes.js';
import { text } from './messages.js';
import { ownerOrgBody, OwnerUnitField, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

interface Draft {
  readonly original: DimensionCategory | null;
  readonly libraryId: string;
  readonly name: string;
  readonly displayOrder: number;
  /** 新建时所选的授权管理单元（只在多个时提交，DEC-294 补充二）。 */
  readonly ownerOrgId: string;
}

const draftOf = (item: DimensionCategory | null, libraryId: string): Draft => ({
  original: item,
  libraryId,
  name: item?.name ?? '',
  displayOrder: item?.displayOrder ?? 1,
  ownerOrgId: '',
});

/**
 * 指标库内分类（DEC-281③）：类别名称（必填，≤50）+ 类别顺序（必填整数），挂在指标库下，无编码、无层级；
 * 所属指标库建后不可改；所属人 = 创建人，所属管理单元取创建人的授权管理单元，不随指标库（DEC-294 补充二）。
 * 被指标引用的分类不能删除。
 */
export function DimensionCategoryPanel({ tenantId }: { tenantId: string }) {
  const [libraryId, setLibraryId] = useState('');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setDraft(null);
    list.reload();
  });
  const path = `dimension-categories${libraryId ? `?libraryId=${libraryId}` : ''}`;
  const list = useList<DimensionCategory>(tenantId, path, write.setError);
  const owners = useOwnerOrgs(tenantId, 'dimensionCategory', write.setError);
  useEffect(() => {
    void listAll<Library>(tenantId, 'libraries')
      .then(setLibraries)
      .catch((cause: unknown) => write.setError(String(cause)));
  }, [tenantId, write.setError]);
  const libraryName = (id: string) => libraries.find((item) => item.id === id)?.name ?? '';
  const save = (value: Draft) => {
    const { original, libraryId: library, ownerOrgId, ...fields } = value;
    write.mutate({
      path: original ? `dimension-categories/${original.id}` : 'dimension-categories',
      method: original ? 'PATCH' : 'POST',
      revision: original?.revision ?? 0,
      body: original
        ? changedFields({ name: original.name, displayOrder: original.displayOrder }, fields)
        : { ...fields, libraryId: library, ...ownerOrgBody(owners, ownerOrgId) },
    });
  };
  return (
    <section aria-busy={write.busy}>
      <select aria-label={text.library} value={libraryId} onChange={(event) => setLibraryId(event.target.value)}>
        <option value="">{text.allLibraries}</option>
        {libraries.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <button
        disabled={write.locked || !libraries.length}
        onClick={() => setDraft(draftOf(null, libraryId || libraries[0]!.id))}
      >
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <CategoryList
        items={list.items}
        libraryName={libraryName}
        locked={write.locked}
        onEdit={(item) => setDraft(draftOf(item, item.libraryId))}
        onDelete={(item) =>
          write.mutate({ path: `dimension-categories/${item.id}`, method: 'DELETE', revision: item.revision })
        }
      />
      <Pager list={list} locked={write.locked} />
      {draft && (
        <CategoryForm
          draft={draft}
          owners={owners}
          libraries={libraries}
          busy={write.locked}
          onChange={setDraft}
          onSubmit={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}

function CategoryList({
  items,
  libraryName,
  locked,
  onEdit,
  onDelete,
}: {
  items: readonly DimensionCategory[];
  libraryName: (id: string) => string;
  locked: boolean;
  onEdit: (item: DimensionCategory) => void;
  onDelete: (item: DimensionCategory) => void;
}) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          {item.name}（{libraryName(item.libraryId)} · {text.displayOrder} {item.displayOrder}）
          <button disabled={locked} onClick={() => onEdit(item)}>
            {text.edit}
          </button>
          <button disabled={locked} onClick={() => window.confirm(text.confirmDelete) && onDelete(item)}>
            {text.delete}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CategoryForm({
  draft,
  owners,
  libraries,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  owners: readonly OwnerOrg[] | undefined;
  libraries: readonly Library[];
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
        <OwnerUnitField
          editing={!!draft.original}
          value={draft.ownerOrgId}
          options={owners}
          onChange={(ownerOrgId) => onChange({ ...draft, ownerOrgId })}
        />
        <label>
          {text.library}
          <select
            value={draft.libraryId}
            disabled={!!draft.original}
            onChange={(event) => onChange({ ...draft, libraryId: event.target.value })}
          >
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
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
            required
            type="number"
            step={1}
            value={draft.displayOrder}
            onChange={(event) => onChange({ ...draft, displayOrder: Number(event.target.value) })}
          />
        </label>
        <button type="submit">{text.save}</button>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
      </fieldset>
    </form>
  );
}
