import { useEffect, useMemo, useState } from 'react';
import { DIMENSION_TYPES, listAll, request, type Category, type Criterion, type Dimension } from './api.js';
import { changedFields } from './changes.js';
import { CriterionForm, type CriterionDraft, type KnownDimension } from './CriterionForm.js';
import { text } from './messages.js';
import { useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { useTalentWrite } from './useTalentWrite.js';

/** 新建时带所属管理单元（建后不可改，编辑草稿里没有这个键）。 */
const draftOf = (item: Criterion | null, categoryId = ''): CriterionDraft => ({
  ...(item ? {} : { ownerOrgId: '' }),
  categoryId: item?.categoryId ?? categoryId,
  name: item?.name ?? '',
  enabled: item?.enabled ?? true,
  abilityNote: item?.abilityNote ?? null,
  potentialNote: item?.potentialNote ?? null,
  experienceNote: item?.experienceNote ?? null,
  achievementNote: item?.achievementNote ?? null,
  dimensions: (item?.dimensions ?? []).map(({ dimensionId, weight, target, displayOrder }) => ({
    dimensionId,
    weight,
    target,
    displayOrder,
  })),
});

/** 人才标准：挂所属管理单元（DEC-281⑨）；引用指标而不复制（TC-R2），详情显示指标库的当前内容。 */
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
  const save = () => {
    if (!editor) return;
    const { original, value } = editor;
    write.mutate(
      original
        ? {
            path: `criteria/${original.id}`,
            method: 'PATCH',
            revision: original.revision,
            body: changedFields(draftOf(original), value),
          }
        : { path: 'criteria', method: 'POST', revision: 0, body: value },
    );
  };
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
      {viewing && <CriterionDetail value={viewing} onClose={() => setViewing(null)} />}
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

/**
 * 标准详情：按 能力 / 潜力 / 经历 分组列出引用的指标，只显示 名称、定义、指标类别、权重、目标（DEC-281⑪）；
 * 被停用的指标照常显示、不加标记（DEC-281⑧）。
 */
function CriterionDetail({ value, onClose }: { value: Criterion; onClose: () => void }) {
  return (
    <article>
      <h2>{value.name}</h2>
      {(['abilityNote', 'potentialNote', 'experienceNote', 'achievementNote'] as const).map(
        (key) =>
          value[key] && (
            <p key={key}>
              {text.notes[key]}：{value[key]}
            </p>
          ),
      )}
      {DIMENSION_TYPES.map((type) => {
        const rows = (value.dimensions ?? []).filter((item) => item.type === type);
        return rows.length ? (
          <table key={type}>
            <caption>{text.types[type]}</caption>
            <thead>
              <tr>
                {[text.name, text.definition, text.dimensionCategory, text.weight, text.target].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.dimensionId}>
                  <td>{item.dimension?.name ?? text.contentHidden}</td>
                  <td>{item.dimension?.definition}</td>
                  <td>{item.dimension?.categoryName}</td>
                  <td>{item.weight ?? ''}</td>
                  <td>{item.target ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null;
      })}
      <button onClick={onClose}>{text.cancel}</button>
    </article>
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
