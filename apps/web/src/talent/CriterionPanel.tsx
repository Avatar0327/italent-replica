import { useEffect, useMemo, useState } from 'react';
import { listAll, request, type Category, type Criterion, type Dimension } from './api.js';
import { changedFields } from './changes.js';
import { CriterionDetail } from './CriterionDetail.js';
import { CriterionForm, type CriterionDraft, type KnownDimension } from './CriterionForm.js';
import { text } from './messages.js';
import { ownerOrgBody, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite, type Write } from './useTalentWrite.js';

/** 新建草稿带所属管理单元键（只在多个授权管理单元时提交，DEC-294③；编辑草稿里没有这个键）。 */
const draftOf = (item: Criterion | null, categoryId = ''): CriterionDraft => ({
  ...(item ? {} : { ownerOrgId: '' }),
  categoryId: item?.categoryId ?? categoryId,
  name: item?.name ?? '',
  enabled: item?.enabled ?? true,
  abilityNote: item?.abilityNote ?? null,
  potentialNote: item?.potentialNote ?? null,
  experienceNote: item?.experienceNote ?? null,
  achievementNote: item?.achievementNote ?? null,
  dimensions: (item?.dimensions ?? []).map(({ dimensionId, weight, target, displayOrder, dimensionCategory }) => ({
    dimensionId,
    weight,
    target,
    displayOrder,
    dimensionCategory,
  })),
});

/** 人才标准：所属管理单元由系统填写（DEC-294③）；引用指标而不复制（TC-R2），详情显示指标库的当前内容。 */
export function CriterionPanel({ tenantId }: { tenantId: string }) {
  const [categoryId, setCategoryId] = useState('');
  const [viewing, setViewing] = useState<Criterion | null>(null);
  const [editor, setEditor] = useState<{ original: Criterion | null; value: CriterionDraft } | null>(null);
  const write = useTalentWrite(tenantId, () => {
    setEditor(null);
    setViewing(null);
    list.reload();
  });
  const list = useList<Criterion>(tenantId, `criteria${categoryId ? `?categoryId=${categoryId}` : ''}`, write.setError);
  const { categories, candidates, known } = useChoices(tenantId, editor, write.setError);
  const owners = useOwnerOrgs(tenantId, 'criterion', write.setError);
  const open = (id: string, edit: boolean) =>
    void request<Criterion>(tenantId, `criteria/${id}`)
      .then((item) => (edit ? setEditor({ original: item, value: draftOf(item) }) : setViewing(item)))
      .catch((cause: unknown) => write.setError(cause instanceof Error ? cause.message : String(cause)));
  const save = () => editor && write.mutate(saveCommand(editor, owners));
  const setCategory = (item: Criterion, dimensionIds: string[], dimensionCategory: string | null) =>
    write.mutate({
      path: `criteria/${item.id}/dimension-category`,
      method: 'POST',
      revision: item.revision,
      body: { dimensionIds, dimensionCategory },
    });
  const categoryName = (id: string) => categories.find((item) => item.id === id)?.name ?? '';
  return (
    <section aria-busy={write.busy}>
      <select aria-label={text.criterionCategory} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        <option value="">{text.allCategories}</option>
        {categories.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <button disabled={write.locked} onClick={() => setEditor({ original: null, value: draftOf(null, categoryId) })}>
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <CriterionTable
        items={list.items}
        categoryName={categoryName}
        locked={write.locked}
        onOpen={open}
        onDelete={(item) => write.mutate({ path: `criteria/${item.id}`, method: 'DELETE', revision: item.revision })}
      />
      <Pager list={list} locked={write.locked} />
      {viewing && (
        <CriterionDetail
          value={viewing}
          locked={write.locked}
          onSetCategory={(ids, category) => setCategory(viewing, ids, category)}
          onClose={() => setViewing(null)}
        />
      )}
      {editor && (
        <CriterionForm
          value={editor.value}
          owners={owners}
          categories={categories}
          known={known}
          candidates={candidates}
          busy={write.locked}
          onChange={(value) => setEditor({ ...editor, value })}
          onSubmit={save}
          onCancel={() => setEditor(null)}
        />
      )}
    </section>
  );
}

/** 保存：编辑只提交改动；新建时所属管理单元只在有多个授权管理单元时随请求提交（DEC-294 补充）。 */
function saveCommand(
  { original, value }: { original: Criterion | null; value: CriterionDraft },
  owners: Parameters<typeof ownerOrgBody>[0],
): Write {
  if (original) {
    const body = changedFields(draftOf(original), value);
    return { path: `criteria/${original.id}`, method: 'PATCH', revision: original.revision, body };
  }
  const { ownerOrgId, ...fields } = value;
  return {
    path: 'criteria',
    method: 'POST',
    revision: 0,
    body: { ...fields, ...ownerOrgBody(owners, ownerOrgId ?? '') },
  };
}

function CriterionTable({
  items,
  categoryName,
  locked,
  onOpen,
  onDelete,
}: {
  items: readonly Criterion[];
  categoryName: (id: string) => string;
  locked: boolean;
  onOpen: (id: string, edit: boolean) => void;
  onDelete: (item: Criterion) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{text.name}</th>
          <th>{text.criterionCategory}</th>
          <th>{text.enabled}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.name}</td>
            <td>{categoryName(item.categoryId)}</td>
            <td>{item.enabled ? '✓' : text.disabled}</td>
            <td>
              <button disabled={locked} onClick={() => onOpen(item.id, false)}>
                {text.view}
              </button>
              <button disabled={locked} onClick={() => onOpen(item.id, true)}>
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

/** 分类下拉、可引用指标候选（只在编辑时加载，TC-R4）与已引用指标的名称 / 类型。 */
function useChoices(
  tenantId: string,
  editor: { original: Criterion | null } | null,
  onError: (message: string) => void,
) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [candidates, setCandidates] = useState<Dimension[]>([]);
  const editing = editor !== null;
  useEffect(() => {
    void listAll<Category>(tenantId, 'criterion-categories')
      .then(setCategories)
      .catch((cause: unknown) => onError(String(cause)));
  }, [tenantId, onError]);
  useEffect(() => {
    if (!editing) return;
    void listAll<Dimension>(tenantId, 'candidates/dimensions')
      .then(setCandidates)
      .catch((cause: unknown) => onError(String(cause)));
  }, [tenantId, editing, onError]);
  const original = editor?.original;
  const known = useMemo(() => {
    const map = new Map<string, KnownDimension>();
    for (const item of candidates) map.set(item.id, { name: item.name, type: item.type });
    for (const reference of original?.dimensions ?? []) {
      map.set(reference.dimensionId, {
        name: reference.dimension?.name ?? reference.dimensionId,
        type: reference.type,
      });
    }
    return map;
  }, [candidates, original]);
  return { categories, candidates, known };
}
