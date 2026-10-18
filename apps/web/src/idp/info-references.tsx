import { Alert, Button, Select, Space } from 'antd';
import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import { PersonAvatar } from '../shared/PersonAvatar.js';
import type { AvatarReference } from '../account/avatar-api.js';
import { loadAll, useCollection } from './api.js';
import { sortLevels } from './info-reference-sort.js';
import { infoText as m, textValue, type InfoRow } from './info-model.js';

export const PEOPLE = '/api/tenant/employment/employees';
export const PROFILE = '/api/tenant/personnel/employees';
export const ORGS = '/api/tenant/org/organizations';
export const POSITIONS = '/api/tenant/job/positions';
export const INFO_SOURCES = {
  org: ORGS,
  position: POSITIONS,
  professionalLine: '/api/tenant/job/professional-lines',
  level: '/api/tenant/job/levels',
  post: '/api/tenant/job/posts',
} as const;
const LEVEL_TYPES = '/api/tenant/job/level-types';
const careerSources: readonly string[] = [INFO_SOURCES.professionalLine, INFO_SOURCES.level, INFO_SOURCES.post];
type Result = { row?: InfoRow; error?: unknown };
/** 按真实接口读引用，失败保留局部错误；无权字段缺席时不拿 ID / 默认值顶替。 */
export function useInfoReferences(paths: readonly string[]) {
  const api = useApiClient();
  const session = useSession();
  const [epoch, setEpoch] = useState(0);
  const signature = JSON.stringify([...new Set(paths)].sort());
  const key = `${session.tenantId}/${session.identityKey}/${epoch}/${signature}`;
  const [state, setState] = useState<{ key: string; values: Record<string, Result> }>({ key: '', values: {} });
  useEffect(() => {
    const controller = new AbortController();
    const queue = JSON.parse(signature) as string[];
    const values: Record<string, Result> = {};
    // 有界并发，避免列表上每位员工同时发出全部关联请求。
    void Promise.all(
      Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length && !controller.signal.aborted) {
          const path = queue.shift()!;
          try {
            const row = path.endsWith('/records')
              ? (await loadAll<InfoRow>(api, path, controller.signal)).items.find((r) => r.isCurrent === true)
              : await api.request<InfoRow>(path, { signal: controller.signal });
            values[path] = { row };
          } catch (error) {
            values[path] = { error };
          }
          if (!controller.signal.aborted) setState({ key, values: { ...values } });
        }
      }),
    );
    return () => controller.abort();
  }, [api, key, signature]);
  const values = state.key === key ? state.values : {};
  return {
    get: (path: string) => values[path]?.row,
    loading: paths.some((p) => !values[p]),
    error: Object.values(values).some((r) => r.error),
    reload: () => setEpoch((n) => n + 1),
  };
}
export function ReferenceError({ refs }: { refs: { error: boolean; reload(): void } }) {
  return refs.error ? (
    <Alert type="error" showIcon message={m.readError} action={<Button onClick={refs.reload}>{m.retry}</Button>} />
  ) : null;
}
export function PersonName({ person }: { person?: InfoRow }) {
  const session = useSession();
  if (typeof person?.name !== 'string') return <>{m.none}</>;
  return (
    <Space size={5}>
      <PersonAvatar
        tenantId={session.tenantId}
        name={person.name}
        avatar={person.avatar as AvatarReference | null}
        size={24}
      />
      <span>{person.name}</span>
    </Space>
  );
}
/** 下拉只对已经返回的可见名称搜索，不把被裁剪字段发作查询。 */
export function InfoSelect({
  source,
  person = false,
  value,
  onChange,
  ...labelled
}: {
  source: string;
  person?: boolean;
  value?: string | null;
  onChange?(value: string | null): void;
  id?: string;
  disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const career = careerSources.includes(source);
  const list = useCollection<InfoRow>(opened ? `${source}${career ? '?enabled=true' : ''}` : undefined);
  // 停用类别下仍可能有启用职级；类别只用于排序，不作为候选过滤条件。
  const categories = useCollection<InfoRow>(
    opened && source === INFO_SOURCES.level ? `${LEVEL_TYPES}?includeDisabled=true` : undefined,
  );
  const refs = useInfoReferences(value ? [`${source}/${value}`, ...(person ? [`${PROFILE}/${value}`] : [])] : []);
  const selected = value ? refs.get(`${source}/${value}`) : undefined;
  const rows = [...(list.items ?? [])].filter((row) => !career || typeof row.name === 'string');
  if (source === INFO_SOURCES.level) sortLevels(rows, categories.items ?? []);
  // 旧目标停用后仍回显名称，但不能把它补回启用候选。
  if (!career && selected && !rows.some((r) => r.id === selected.id)) rows.push(selected);
  const options = rows.map((row) => ({
    value: row.id,
    search: textValue(row.name),
    label: person ? <PersonName person={row} /> : textValue(row.name),
  }));
  const email = value && person ? refs.get(`${PROFILE}/${value}`)?.email : undefined;
  return (
    <>
      <Select
        {...labelled}
        value={value ?? undefined}
        allowClear
        placeholder={m.choose}
        showSearch
        optionFilterProp="search"
        options={options}
        onOpenChange={(open) => open && setOpened(true)}
        loading={list.loading || categories.loading || refs.loading}
        onChange={(v: string | undefined) => onChange?.(v ?? null)}
        labelRender={(option) => (
          <Space size={4}>
            {options.find((o) => o.value === option.value)?.label ?? textValue(selected?.name)}
            {typeof email === 'string' && email ? `(${email})` : ''}
          </Space>
        )}
      />
      <ReferenceError
        refs={{
          error: refs.error || !!list.error || !!categories.error,
          reload: () => {
            refs.reload();
            list.reload();
            categories.reload();
          },
        }}
      />
    </>
  );
}
