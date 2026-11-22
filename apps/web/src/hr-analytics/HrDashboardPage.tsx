import { Alert, Button } from 'antd';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { tenantDate } from '../foundation/dates.js';
import { ui } from '../foundation/messages.js';
import { useReportRetryWait } from '../hr-reports/ReportReadState.js';
import { QueryFilters } from '../hr-reports/ReportFilters.js';
import { m as report } from '../hr-reports/messages.js';
import { cellText } from '../hr-reports/model.js';
import { useReportRead } from '../hr-reports/useReportRead.js';
import { BoardDetailDrawer } from './BoardDetailDrawer.js';
import { ReadState } from './ReadState.js';
import { m } from './messages.js';
import {
  asOfBounds,
  canRetryRead,
  detailTable,
  detailUrl,
  indicatorGroups,
  overviewUrl,
  readStatus,
  validAsOf,
  type DashboardDetail,
  type DashboardMetric,
  type DashboardOverview,
} from './model.js';
import { dashboardPath, deliveredTabs } from './pages.js';
import '../hr-reports/hr-reports.css';
import './hr-dashboard.css';

const dateFields = [{ key: 'asOf', label: report.asOf, type: 'date', bounds: asOfBounds }];

interface Selection {
  metric: DashboardMetric;
  asOf: string;
  page: number;
}
type Invalidated = 'forbidden' | 'login' | 'scope';

function detailInvalidation(error: unknown, data?: DashboardDetail): Invalidated | undefined {
  if (readStatus(error) === 401) return 'login';
  if (readStatus(error) === 403) return 'forbidden';
  if (data?.hasDataPermission === false) return 'scope';
  return undefined;
}

function Metrics({
  data,
  waiting,
  open,
}: {
  data: DashboardOverview;
  waiting: boolean;
  open(metric: DashboardMetric): void;
}) {
  return indicatorGroups(data.indicators).map(({ title, items }, index) => (
    <section key={title} className="hr-dashboard-section">
      <h2>{title}</h2>
      <div className={index < 2 ? 'hr-dashboard-cards' : 'hr-dashboard-metrics'}>
        {items.map((metric) => (
          <article key={metric.code} aria-label={metric.name} className="hr-dashboard-metric">
            <h3>{metric.name}</h3>
            <strong>{cellText('value', metric.value)}</strong>
            <Button
              type="link"
              disabled={waiting || !data.hasDataPermission}
              onClick={() => open(metric)}
              aria-label={m.viewDetails}
            >
              {m.viewDetails}
            </Button>
          </article>
        ))}
      </div>
    </section>
  ));
}

function ScopeNotes() {
  return (
    <div className="list-card hr-dashboard-scope">
      <p>{m.peopleScope}</p>
      <p>{m.contractScope}</p>
      <p>{m.workflowScope}</p>
    </div>
  );
}

function ManagementBoard({ today, refresh }: { today: string; refresh(): void }) {
  const [query, setQuery] = useState({ asOf: today, generation: 0 });
  const [selected, select] = useState<Selection>();
  const [detailGeneration, setDetailGeneration] = useState(0);
  const [invalidated, setInvalidated] = useState<Invalidated>();
  const read = useReportRead<DashboardOverview>(invalidated ? null : overviewUrl(query.asOf), query.generation);
  const detail = useReportRead<DashboardDetail>(
    selected ? detailUrl(selected.metric.code, selected.asOf, selected.page) : null,
    detailGeneration,
  );
  const currentInvalidation = detailInvalidation(detail.error, detail.data);
  const blocked = currentInvalidation ?? invalidated;
  useEffect(() => {
    if (currentInvalidation) setInvalidated(currentInvalidation);
  }, [currentInvalidation]);
  const retryAt = Math.max(detail.failure?.retryAt ?? 0, read.failure?.retryAt ?? 0);
  const [lastRetryAt, setLastRetryAt] = useState(0);
  // 关闭抽屉会清掉明细失败，但不能提前解除 Retry-After。
  if (retryAt > lastRetryAt) setLastRetryAt(retryAt);
  const waiting = useReportRetryWait(Math.max(retryAt, lastRetryAt));
  const data = blocked ? undefined : read.data;
  const forbidden = blocked === 'forbidden' || readStatus(read.error) === 403;
  const noScope = blocked === 'scope' || data?.hasDataPermission === false;
  if (blocked === 'login' || readStatus(read.error) === 401) return <PageState kind="login" />;

  const apply = (asOf: string) => {
    select(undefined);
    setInvalidated(undefined);
    setQuery((previous) => ({ asOf, generation: previous.generation + 1 }));
  };
  const changeDetail = (selection: Selection) => {
    select(selection);
    setDetailGeneration((generation) => generation + 1);
  };

  return (
    <>
      <div className="list-card hr-dashboard-filters">
        <QueryFilters
          fields={dateFields}
          initial={{ asOf: today }}
          busy={read.loading || forbidden}
          submitDisabled={waiting}
          validate={({ asOf }) => validAsOf(asOf ?? '')}
          apply={({ asOf }) => apply(asOf!)}
        />
        {data && <p className="hr-dashboard-date">{m.asOf(data.asOf)}</p>}
      </div>
      <ScopeNotes />
      {forbidden ? (
        <Alert
          type="error"
          role="alert"
          message={m.boardDenied}
          action={<Button onClick={refresh}>{ui.refreshPage}</Button>}
        />
      ) : (
        <ReadState
          loading={read.loading}
          error={read.error}
          waiting={waiting}
          retry={canRetryRead(read.error) ? () => apply(query.asOf) : undefined}
        />
      )}
      {noScope && <Alert type="info" message={report.noScope} />}
      {data && (
        <Metrics data={data} waiting={waiting} open={(metric) => changeDetail({ metric, asOf: data.asOf, page: 1 })} />
      )}
      {selected && (
        <BoardDetailDrawer
          title={selected.metric.name}
          asOf={selected.asOf}
          read={detail}
          table={detail.data?.hasDataPermission ? detailTable(detail.data) : undefined}
          waiting={waiting}
          close={() => select(undefined)}
          changePage={(page) => changeDetail({ ...selected, page })}
          retry={() => changeDetail(selected)}
        />
      )}
    </>
  );
}

export function HrDashboardPage() {
  const session = useSession();
  const { snapshot, refresh } = usePermissions();
  const suffix = (useParams()['*'] ?? '').replace(/\/$/, '');
  const visible = deliveredTabs.filter((tab) => snapshot.objects[tab.objectCode]);
  if (!suffix && visible[0]) return <Navigate to={`${dashboardPath}/${visible[0].path}`} replace />;
  const tab = deliveredTabs.find((item) => item.path === suffix);
  if (suffix && !tab) return <PageState kind="not-found" />;
  if (!tab || !visible.includes(tab)) return <PageState kind="forbidden" refresh={refresh} />;
  const today = session.today ?? tenantDate(new Date(), session.timezone);
  return (
    <section className="list-page hr-dashboard">
      <DecisionNote id="hr-dashboard" />
      <nav aria-label={m.dashboard} className="hr-dashboard-tabs">
        {visible.map((item) => (
          <NavLink key={item.path} to={`${dashboardPath}/${item.path}`}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <header className="page-heading">
        <h1>{tab.label}</h1>
      </header>
      <ManagementBoard key={`${session.tenantId}/${session.identityKey}/${tab.path}`} today={today} refresh={refresh} />
    </section>
  );
}
