import { useMemo, useState } from 'react';
import { request, type Category, type Criterion, type Dimension } from './api.js';
import { changedFields } from './changes.js';
import { CriterionDetail } from './CriterionDetail.js';
import { CriterionForm, type CriterionDraft, type KnownDimension } from './CriterionForm.js';
import { canEdit, editableBody, useFormAccess, type FormAccess } from './FormAccess.js';
import { text } from './messages.js';
import { ownerOrgBody, useOwnerOrgs } from './OwnerOrgSelect.js';
import { Pager, Status } from './parts.js';
import { useList } from './useList.js';
import { FreshEditNotice, readFields, useFreshEditor } from './useFreshEditor.js';
import { useTalentWrite, type Write } from './useTalentWrite.js';
import { candidateLabel, CandidateNotice, candidatesBlocked, useCandidates } from './useCandidates.js';

interface Editor {
  readonly original: Criterion | null;
  readonly value: CriterionDraft;
}

/**
 * 新建草稿带所属管理单元键，编辑草稿带“新加指标的所属管理单元”键：都只在多个授权管理单元时由用户选择并提交
 * （DEC-294③ 及补充二），其余情况由服务端填写。
 */
const draftOf = (item: Criterion | null, categoryId = ''): CriterionDraft => {
  if (!item)
    return {
      ownerOrgId: '',
      categoryId,
      name: '',
      enabled: true,
      abilityNote: null,
      potentialNote: null,
      experienceNote: null,
      achievementNote: null,
      dimensions: [],
    };
  const fields = readFields(item, [
    'categoryId',
    'name',
    'enabled',
    'abilityNote',
    'potentialNote',
    'experienceNote',
    'achievementNote',
    'dimensions',
  ]);
  return {
    ...fields,
    relationOwnerOrgId: '',
    ...(fields.dimensions
      ? {
          dimensions: fields.dimensions.map(({ dimensionId, weight, target, displayOrder, dimensionCategory }) => ({
            dimensionId,
            weight,
            target,
            displayOrder,
            dimensionCategory,
          })),
        }
      : {}),
  };
};
const editorOf = (item: Criterion): Editor => ({ original: item, value: draftOf(item) });

function openCriterionDetail(
  tenantId: string,
  id: string,
  onLoaded: (item: Criterion) => void,
  onError: (message: string) => void,
) {
  void request<Criterion>(tenantId, `criteria/${id}`)
    .then(onLoaded)
    .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
}

/** 人才标准：所属管理单元由系统填写（DEC-294③）；引用指标而不复制（TC-R2），详情显示指标库的当前内容。 */
export function CriterionPanel({ tenantId }: { tenantId: string }) {
  const [categoryId, setCategoryId] = useState('');
  const [viewing, setViewing] = useState<Criterion | null>(null);
  const fresh = useFreshEditor(tenantId, 'criteria', editorOf);
  const { editor, setEditor } = fresh;
  const write = useTalentWrite(tenantId, () => {
    setEditor(null);
    setViewing(null);
    list.reload();
  });
  const list = useList<Criterion>(tenantId, `criteria${categoryId ? `?categoryId=${categoryId}` : ''}`, write.setError);
  const choices = useChoices(tenantId, editor);
  const { categories, candidates, known } = choices;
  const owners = useOwnerOrgs(tenantId, 'criterion');
  const { access, existing, blocked } = useEditorAccess(tenantId, editor, owners, choices);
  const open = (id: string, edit: boolean) =>
    edit ? fresh.edit(id) : openCriterionDetail(tenantId, id, setViewing, write.setError);
  const save = () => editor && !blocked && write.mutate(saveCommand(editor, owners.items, access.access));
  const setCategory = (item: Criterion, dimensionIds: string[], dimensionCategory: string | null) =>
    write.mutate({
      path: `criteria/${item.id}/dimension-category`,
      method: 'POST',
      revision: item.revision,
      body: { dimensionIds, dimensionCategory },
    });
  const categoryName = (id: string) => categories.find((item) => item.id === id)?.name ?? '';
  return (
    <section aria-busy={write.busy || fresh.loading}>
      <CandidateNotice state={choices.categoryState} label={text.criterionCategory} />
      <select aria-label={text.criterionCategory} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        <option value="">{text.allCategories}</option>
        {categories.map((item) => (
          <option key={item.id} value={item.id}>
            {candidateLabel(item)}
          </option>
        ))}
      </select>
      <button disabled={write.locked} onClick={() => setEditor({ original: null, value: draftOf(null, categoryId) })}>
        {text.create}
      </button>
      <Status write={write} hasDataPermission={list.hasDataPermission} />
      <FreshEditNotice state={fresh} />
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
          existing={existing}
          owners={owners.items}
          ownerState={owners}
          categoryState={choices.categoryState}
          candidateState={choices.candidateState}
          access={access}
          blocked={blocked}
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

function useEditorAccess(
  tenantId: string,
  editor: Editor | null,
  owners: ReturnType<typeof useOwnerOrgs>,
  choices: ReturnType<typeof useChoices>,
) {
  const access = useFormAccess(tenantId, 'criterion', editor?.original, editor?.original);
  const existing = new Set(editor?.original?.dimensions?.map((item) => item.dimensionId));
  const adding =
    canEdit(access.access, 'dimensions') && editor?.value.dimensions?.some((item) => !existing.has(item.dimensionId));
  const blocked =
    access.blocked ||
    (!!editor && !editor.original && (candidatesBlocked(owners) || candidatesBlocked(choices.categoryState))) ||
    (!!adding && candidatesBlocked(owners));
  return { access, existing, blocked };
}

/** 保存：编辑只提交改动；新建时所属管理单元只在有多个授权管理单元时随请求提交（DEC-294 补充）。 */
function saveCommand(
  { original, value }: { original: Criterion | null; value: CriterionDraft },
  owners: Parameters<typeof ownerOrgBody>[0],
  access: FormAccess,
): Write {
  if (original) {
    const changes = changedFields(draftOf(original), value);
    const body = {
      ...editableBody(changes, access),
      ...(canEdit(access, 'dimensions') && changes.dimensions && changes.relationOwnerOrgId
        ? { relationOwnerOrgId: changes.relationOwnerOrgId }
        : {}),
    };
    return { path: `criteria/${original.id}`, method: 'PATCH', revision: original.revision, body };
  }
  const { ownerOrgId, ...fields } = value;
  return {
    path: 'criteria',
    method: 'POST',
    revision: 0,
    body: { ...editableBody(fields, access), ...ownerOrgBody(owners, ownerOrgId ?? '') },
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
function useChoices(tenantId: string, editor: { original: Criterion | null } | null) {
  const categoryState = useCandidates<Category>(tenantId, 'criterion-categories');
  const candidateState = useCandidates<Dimension>(tenantId, 'candidates/dimensions', editor !== null);
  const original = editor?.original;
  const known = useMemo(() => {
    const map = new Map<string, KnownDimension>();
    for (const item of candidateState.items ?? []) map.set(item.id, { name: item.name ?? item.id, type: item.type });
    for (const reference of original?.dimensions ?? []) {
      map.set(reference.dimensionId, {
        name: reference.dimension?.name ?? reference.dimensionId,
        type: reference.type,
      });
    }
    return map;
  }, [candidateState.items, original]);
  return {
    categories: categoryState.items ?? [],
    candidates: candidateState.items ?? [],
    known,
    categoryState,
    candidateState,
  };
}
