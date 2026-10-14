import { useState } from 'react';
import { DIMENSION_TYPES, type Criterion, type CriterionDimension } from './api.js';
import { text } from './messages.js';
import { PotentialModelImage } from './PotentialModelImage.js';
import { useTalentTenant } from './TalentTenantContext.js';

/**
 * 标准详情：按 能力 / 潜力 / 经历 分组列出引用的指标，只显示 名称、定义、指标类别、权重、目标（DEC-281⑪）；
 * 指标类别是关联记录自己的字段（DEC-294⑤）。被停用的指标照常显示、不加标记（DEC-281⑧）。
 * 勾选指标后可「设置指标类别」：给它们统一填写一个类别（留空即清空），由服务端校验按钮、字段编辑权与范围。
 */
export function CriterionDetail({
  value,
  locked,
  onSetCategory,
  onClose,
}: {
  value: Criterion;
  locked: boolean;
  onSetCategory: (dimensionIds: string[], dimensionCategory: string | null) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const tenantId = useTalentTenant();
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
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
        return rows.length || type === 'potential' ? (
          <section key={type}>
            {type === 'potential' && tenantId && (
              <PotentialModelImage tenantId={tenantId} criterionId={value.id} locked={locked} />
            )}
            <ReferenceTable caption={text.types[type]} rows={rows} selected={selected} onToggle={toggle} />
          </section>
        ) : null;
      })}
      <CategoryBatch
        disabled={locked || selected.size === 0}
        onSubmit={(category) => onSetCategory([...selected], category)}
      />
      <button onClick={onClose}>{text.cancel}</button>
    </article>
  );
}

function ReferenceTable({
  caption,
  rows,
  selected,
  onToggle,
}: {
  caption: string;
  rows: readonly CriterionDimension[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>{text.selectedDimensions}</th>
          {[text.name, text.definition, text.dimensionCategory, text.weight, text.target].map((label) => (
            <th key={label}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.dimensionId}>
            <td>
              <input
                type="checkbox"
                aria-label={item.dimension?.name ?? item.dimensionId}
                checked={selected.has(item.dimensionId)}
                onChange={(event) => onToggle(item.dimensionId, event.target.checked)}
              />
            </td>
            <td>{item.dimension?.name ?? text.contentHidden}</td>
            <td>{item.dimension?.definition}</td>
            <td>{item.dimensionCategory}</td>
            <td>{item.weight ?? ''}</td>
            <td>{item.target ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 「设置指标类别」弹层的复刻：一个文本框 + 提交，给勾选的指标统一填写。 */
function CategoryBatch({ disabled, onSubmit }: { disabled: boolean; onSubmit: (category: string | null) => void }) {
  const [category, setCategory] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(category.trim() || null);
      }}
    >
      <label>
        {text.dimensionCategory}
        <input maxLength={50} value={category} onChange={(event) => setCategory(event.target.value)} />
      </label>
      <button type="submit" disabled={disabled}>
        {text.setDimensionCategory}
      </button>
    </form>
  );
}
