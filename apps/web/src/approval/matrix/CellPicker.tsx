// 单元格选值：条件列按维度查设计器组织 / 职位 / 职务候选（带租户业务日），角色列查设计器人员候选（同 variables/people.tsx）。
// 一页最多几百个单元格，候选只在展开或搜索时读取；已选值的名称取详情 referenceNames 与本次选中的候选。
import type { ApproverSourceType } from '@italent/domain';
import { Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { codeText } from '../../foundation/code-text.js';
import { tenantDate } from '../../foundation/dates.js';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { ui } from '../../foundation/messages.js';
import { readCandidates } from '../designer/source-candidates.js';
import { PEOPLE_PATH, type Person } from '../variables/model.js';
import { sm } from './structure-messages.js';
import type { Names } from './structure-model.js';

interface Choice {
  value: string;
  label: string;
}
const personLabel = (person: Person) =>
  [person.name, codeText(person.code), person.departmentName].filter(Boolean).join(' · ');

/**
 * 名称缓存按会话（租户 + 身份）隔离、挂在模块级：结果未知锁定后离开再回来，草稿里新选的值仍显示名称。
 * null 表示服务端查不到（已删除或不在本租户），显示“已失效”。
 */
const cache = new Map<string, Map<string, string | null>>();
export function useLabels() {
  const session = useSession();
  const scope = JSON.stringify([session.tenantId, session.identityKey]);
  if (!cache.has(scope)) cache.set(scope, new Map());
  const known = cache.get(scope)!;
  return {
    label: (kind: string, id: string) => {
      const name = known.get(`${kind}:${id}`);
      return name === undefined ? id : (name ?? sm.missing);
    },
    remember(kind: string, choices: readonly Choice[]) {
      for (const choice of choices) known.set(`${kind}:${choice.value}`, choice.label);
    },
    /** 详情的 referenceNames：person → 人员投影，维度 → 名称。 */
    adopt(names: Names) {
      for (const [kind, group] of Object.entries(names))
        for (const [id, value] of Object.entries(group ?? {})) {
          const name = kind === 'person' ? (value ? personLabel(value as Person) : null) : (value as string | null);
          known.set(`${kind}:${id}`, typeof name === 'string' ? name : null);
        }
    },
  };
}
export type Labels = ReturnType<typeof useLabels>;

function useOptions(kind: string, open: boolean, keyword: string) {
  const api = useApiClient();
  const { timezone } = useSession();
  const [result, setResult] = useState<{ options: Choice[]; failed?: boolean }>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    const load = async (): Promise<Choice[]> => {
      if (kind === 'person') {
        const query = new URLSearchParams({ keyword, page: '1', pageSize: '50' });
        const page = await api.request<{ items: Person[] }>(`${PEOPLE_PATH}?${query}`, { signal });
        return page.items.map((person) => ({ value: person.userId, label: personLabel(person) }));
      }
      const asOf = tenantDate(new Date(), timezone);
      const page = await readCandidates(api, { type: kind as ApproverSourceType, asOf, keyword }, signal);
      return page.items.map((item) => ({ value: item.id, label: item.name }));
    };
    setResult(undefined);
    const timer = setTimeout(
      () =>
        void load().then(
          (options) => !signal.aborted && setResult({ options }),
          () => !signal.aborted && setResult({ options: [], failed: true }),
        ),
      keyword ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, timezone, kind, open, keyword]);
  return result;
}

export function CellPicker(props: {
  kind: string;
  value: string[];
  max: number;
  labels: Labels;
  disabled: boolean;
  label: string;
  onChange(value: string[]): void;
}) {
  const { kind, value, max, labels, disabled, label, onChange } = props;
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const result = useOptions(kind, open && !disabled, keyword);
  // 选中项的名称先记下再改草稿：重渲染时标签已在缓存里
  const options = useRef<Choice[]>([]);
  options.current = result?.options ?? [];
  let empty: string = ui.empty;
  if (!result) empty = ui.loading;
  else if (result.failed) empty = ui.failed;
  return (
    <Select
      mode="multiple"
      labelInValue
      showSearch
      filterOption={false}
      maxCount={max}
      maxTagCount={3}
      className="matrix-picker"
      aria-label={label}
      placeholder={sm.pick}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setKeyword('');
      }}
      onSearch={setKeyword}
      notFoundContent={empty}
      options={options.current}
      value={value.map((id) => ({ value: id, label: labels.label(kind, id) }))}
      onChange={(next: Choice[]) => {
        if (disabled) return;
        labels.remember(
          kind,
          options.current.filter((option) => next.some((item) => item.value === option.value)),
        );
        onChange(next.map((item) => item.value));
      }}
    />
  );
}
