import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form } from 'antd';
import type { ApprovalNode } from '@italent/domain';
import { useApiClient } from '../../foundation/Session.js';
import { PersonSelect, type Choice } from '../../foundation/selectors.js';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import { nodeField } from './model.js';
import { fallbackError, supportsFallback } from './fallback.js';
import { m } from './messages.js';

const endpoint = '/api/tenant/approval/designer/person-candidates';
type Person = { userId: string; name: string; code: string; departmentName: string | null };
type Result = { items: Person[]; hasMore: boolean };
const choice = (person: Person): Choice => ({
  value: person.userId,
  label: [person.name, person.code, person.departmentName].filter(Boolean).join(' · '),
});
export function FallbackHandlers({ node, approvalType }: { node: ApprovalNode; approvalType: string }) {
  if (!supportsFallback(node, approvalType)) return null;
  return (
    <Form.Item
      name={nodeField(node.key, 'fallbackUserIds')}
      label={m.fallback}
      rules={[
        {
          validator: async (_, value) => {
            const error = fallbackError(value);
            if (error) throw new Error(error);
          },
        },
      ]}
    >
      <FallbackValue />
    </Form.Item>
  );
}
/** 只适配账号 ID 与标签；选择交互复用 PersonSelect，提交状态由外层 FormLock / F-315 内核管理。 */
function FallbackValue({
  value = [],
  onChange,
  id,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
  id?: string;
}) {
  const api = useApiClient();
  const lock = useFormLock();
  const key = JSON.stringify(value);
  const [read, setRead] = useState<{ key: string; choices: Choice[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const ids = JSON.parse(key) as string[];
    if (!ids.length) {
      setRead({ key, choices: [], failed: false });
      return;
    }
    void api
      .request<Result>(`${endpoint}?${new URLSearchParams({ userIds: ids.join(',') })}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setRead({ key, choices: result.items.map(choice), failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead({ key, choices: [], failed: true });
      });
    return () => controller.abort();
  }, [api, key, attempt]);
  const load = useCallback(
    async (keyword: string, signal: AbortSignal): Promise<Choice[]> => {
      const items: Choice[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await api.request<Result>(
          `${endpoint}?${new URLSearchParams({ keyword, page: String(page), pageSize: '200' })}`,
          { signal },
        );
        items.push(...result.items.map(choice));
        if (!result.hasMore) return items;
      }
      throw new Error(m.fallbackTooMany);
    },
    [api],
  );
  const known = read?.key === key ? read : undefined;
  const expired = !!known && !known.failed && value.some((userId) => !known.choices.some((c) => c.value === userId));
  const selected = value.map(
    (userId) =>
      known?.choices.find((c) => c.value === userId) ?? {
        value: userId,
        label: `${userId}${known && !known.failed ? ` · ${m.fallbackExpired}` : ''}`,
      },
  );
  return (
    <>
      <PersonSelect
        multiple
        id={id}
        label={m.fallback}
        value={selected}
        load={load}
        disabled={lock.disabled}
        onChange={lock.guard((next) => onChange?.(next.map((item) => item.value)))}
      />
      {fallbackError(value) && <Alert type="error" message={fallbackError(value)} />}
      {expired && <Alert type="warning" message={m.fallbackRemove} />}
      {known?.failed && (
        <Alert
          type="warning"
          message={m.fallbackReadFailed}
          action={<Button onClick={() => retry(attempt + 1)}>{m.refresh}</Button>}
        />
      )}
    </>
  );
}
