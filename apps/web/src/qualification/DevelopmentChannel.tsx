import { Button, Card, Descriptions, Empty, Tag } from 'antd';
import { useCallback, useState } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { DetailPage } from '../foundation/templates.js';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { PageState } from '../foundation/PageState.js';
import { PersonSelect, type Choice } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { candidates } from '../talent/catalog/api.js';
import { useRemote } from '../talent/catalog/hooks.js';
import { StandardCells, display } from '../talent/catalog/ResourceDetail.js';
import { m } from '../talent/catalog/messages.js';
import type { Row } from '../talent/catalog/types.js';
import { q } from './messages.js';
interface Channel {
  asOf: string;
  current: { categoryId: string; levelId: string; startDate?: string } | null;
  vertical: { levelId: string; displayOrder?: number }[];
  horizontal: { levelId?: string; targetCategoryId?: string; targetLevelId?: string }[];
}
export function DevelopmentChannel() {
  const api = useApiClient();
  const [person, setPerson] = useState<Choice>();
  const load = useCallback(
    async (search: string, signal: AbortSignal) => {
      const params = new URLSearchParams(search ? { employeeName: search } : {});
      const rows = await candidates(api, `/api/tenant/personnel/employees?${params}`, signal);
      return rows.map((row) => ({ value: row.id, label: row.name ?? row.id }));
    },
    [api],
  );
  return (
    <div className="catalog-page">
      <DecisionNote id="qualification-channel" />
      <header className="page-heading">
        <ViewHeading title={q.channels} />
      </header>
      <div style={{ maxWidth: 340 }}>
        <PersonSelect value={person} onChange={setPerson} load={load} />
      </div>
      {person ? (
        <EmployeeChannel key={person.value} employeeId={person.value} />
      ) : (
        <Empty description={q.chooseEmployee} />
      )}
    </div>
  );
}
function EmployeeChannel({ employeeId }: { employeeId: string }) {
  const base = `/api/tenant/qualification/employees/${employeeId.toLowerCase()}/development-channel`;
  const [selected, setSelected] = useState<{ levelId: string; categoryId?: string }>();
  const channel = useRemote(base, (api, signal) => api.request<Channel>(base, { signal }));
  const name = useChannelNames(base);
  const data = channel.data;
  if (channel.error) return <PageState kind="error" error={channel.error} />;
  if (!data) return <PageState kind="loading" />;
  if (!data.current) return <Empty description={q.noChannel} />;
  return (
    <>
      <Card
        title={q.currentQualification}
        extra={
          <span className="channel-date">
            {q.asOf}：{data.asOf}
          </span>
        }
        style={{ marginTop: 24 }}
      >
        <Descriptions
          items={[
            { key: 'category', label: q.category, children: name(data.current.categoryId) },
            { key: 'level', label: q.current, children: name(data.current.levelId) },
            { key: 'date', label: q.startDate, children: display(data.current.startDate) },
          ]}
        />
      </Card>
      <h2>{q.vertical}</h2>
      <div className="channel-path">
        {data.vertical.map((node) => (
          <div key={node.levelId} className={`channel-node ${node.levelId === data.current?.levelId ? 'current' : ''}`}>
            {node.levelId === data.current?.levelId && <Tag color="blue">{q.current}</Tag>}
            <h3>{name(node.levelId)}</h3>
            <Button type="link" onClick={() => setSelected({ levelId: node.levelId })}>
              {q.viewStandard}
            </Button>
          </div>
        ))}
        {!data.vertical.length && <Empty />}
      </div>
      <h2>{q.horizontal}</h2>
      <div className="channel-path">
        {data.horizontal.map((node, index) => (
          <div key={index} className="channel-node">
            <h3>{name(node.targetCategoryId)}</h3>
            <p>
              {name(node.levelId)} → {name(node.targetLevelId)}
            </p>
            {node.targetLevelId && node.targetCategoryId && (
              <Button
                type="link"
                onClick={() => setSelected({ levelId: node.targetLevelId!, categoryId: node.targetCategoryId })}
              >
                {q.viewStandard}
              </Button>
            )}
          </div>
        ))}
        {!data.horizontal.length && <Empty />}
      </div>
      {selected && (
        <LevelDetail
          key={`${selected.categoryId}:${selected.levelId}`}
          base={base}
          selected={selected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
function LevelDetail({
  base,
  selected,
  onClose,
}: {
  base: string;
  selected: { levelId: string; categoryId?: string };
  onClose(): void;
}) {
  const path = `${base}/levels/${selected.levelId}${selected.categoryId ? `?categoryId=${selected.categoryId}` : ''}`;
  const state = useRemote(path, (api, signal) =>
    api.request<{ level: { description?: string; cells?: unknown[] } }>(path, { signal }),
  );
  return (
    <DetailPage
      open
      title={q.viewStandard}
      onClose={onClose}
      actions={<Button onClick={onClose}>{m.close}</Button>}
      summary={
        state.error ? (
          <PageState kind="error" error={state.error} />
        ) : !state.data ? (
          <PageState kind="loading" />
        ) : (
          <>
            <p>{state.data.level.description}</p>
            <StandardCells cells={state.data.level.cells} />
            <p>{q.courses}</p>
          </>
        )
      }
    />
  );
}

function useChannelNames(base: string) {
  const names = useRemote(`${base}:names`, async (api, signal) => {
    const lookup = async (path: string) => {
      try {
        return await candidates(api, `/api/tenant/qualification/${path}`, signal);
      } catch {
        return [] as Row[];
      }
    };
    const [levels, categories] = await Promise.all([lookup('levels'), lookup('categories')]);
    return new Map([...levels, ...categories].map((row) => [row.id, row.name ?? row.id]));
  });
  return (id?: string) => (id ? (names.data?.get(id) ?? id) : m.unknown);
}
