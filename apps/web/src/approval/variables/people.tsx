// 变量里的人员：默认值选人与列表上的人名。候选与回显都走流程矩阵菜单下的设计器人员接口（同一权限，不另开口子）。
import { useCallback, useEffect, useState } from 'react';
import { codeText } from '../../foundation/code-text.js';
import { useApiClient } from '../../foundation/Session.js';
import { PersonSelect, type Choice } from '../../foundation/selectors.js';
import { m } from './messages.js';
import { PEOPLE_PATH, type Person } from './model.js';

type Result = { items: Person[]; hasMore: boolean };
const choiceOf = (person: Person): Choice => ({
  value: person.userId,
  label: [person.name, codeText(person.code), person.departmentName].filter(Boolean).join(' · '),
});

/** 列表上的人名（最近修改人）：按 ID 批量回显，每批 100；读不到时显示缺省占位，不影响列表。 */
export function usePeopleNames(ids: readonly string[]) {
  const api = useApiClient();
  const key = JSON.stringify([...new Set(ids)].sort());
  const [names, setNames] = useState<{ key: string; map: Map<string, string> }>();
  useEffect(() => {
    const list = JSON.parse(key) as string[];
    const controller = new AbortController();
    if (!list.length) return;
    void (async () => {
      const map = new Map<string, string>();
      for (let offset = 0; offset < list.length; offset += 100) {
        const query = new URLSearchParams({ userIds: list.slice(offset, offset + 100).join(',') });
        const result = await api.request<Result>(`${PEOPLE_PATH}?${query}`, { signal: controller.signal });
        for (const person of result.items) map.set(person.userId, person.name);
      }
      if (!controller.signal.aborted) setNames({ key, map });
    })().catch(() => undefined);
    return () => controller.abort();
  }, [api, key]);
  return (id: string | null) => (id && names?.key === key ? names.map.get(id) : undefined) ?? m.missing;
}

/** 人员 / 多人默认值：值是账号 ID（多人为数组），标签取行上回显的 people 与本次选中的候选。 */
export function PersonValue(props: {
  value?: string | string[] | null;
  onChange?: (value: string | string[] | null) => void;
  multiple: boolean;
  people: readonly Person[];
  id?: string;
  disabled?: boolean;
}) {
  const { value, onChange, multiple, people, id, disabled } = props;
  const api = useApiClient();
  const [known, setKnown] = useState<Choice[]>(() => people.map(choiceOf));
  const load = useCallback(
    async (keyword: string, signal: AbortSignal) => {
      const query = new URLSearchParams({ keyword, page: '1', pageSize: '50' });
      return (await api.request<Result>(`${PEOPLE_PATH}?${query}`, { signal })).items.map(choiceOf);
    },
    [api],
  );
  const ids = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  const selected = ids.map((userId) => known.find((item) => item.value === userId) ?? { value: userId, label: userId });
  const remember = (chosen: Choice[]) =>
    setKnown((list) => [...list.filter((item) => !chosen.includes(item)), ...chosen]);
  return multiple ? (
    <PersonSelect
      id={id}
      label={m.personPlaceholder}
      load={load}
      disabled={disabled}
      multiple
      value={selected}
      onChange={(next) => {
        remember(next);
        onChange?.(next.length ? next.map((item) => item.value) : null);
      }}
    />
  ) : (
    <PersonSelect
      id={id}
      label={m.personPlaceholder}
      load={load}
      disabled={disabled}
      value={selected[0]}
      onChange={(next) => {
        if (next) remember([next]);
        onChange?.(next?.value ?? null);
      }}
    />
  );
}
