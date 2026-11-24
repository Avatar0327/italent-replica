import { Alert, Button } from 'antd';
import { Navigate, NavLink, useParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { tenantDate } from '../foundation/dates.js';
import { ui } from '../foundation/messages.js';
import { QueryFilters } from '../hr-reports/ReportFilters.js';
import { m as report } from '../hr-reports/messages.js';
import { cellText } from '../hr-reports/model.js';
import { MovementBoard } from './MovementBoard.js';
import { ProcessBoard } from './ProcessBoard.js';
import { StructureBoard } from './StructureBoard.js';
import { useBoardRead } from './useBoardRead.js';
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
  validAsOf,
  type DashboardDetail,
  type DashboardMetric,
  type DashboardOverview,
} from './model.js';
import { dashboardPath, deliveredTabs } from './pages.js';
import '../hr-reports/hr-reports.css';
import './hr-dashboard.css';

const dateFields = [{ key: 'asOf', label: report.asOf, type: 'date', bounds: asOfBounds }];

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
  const board = useBoardRead<string, DashboardMetric, DashboardOverview, DashboardDetail>(
    today,
    overviewUrl,
    ({ target, asOf, page }) => detailUrl(target.code, asOf, page),
  );
  const { data, read, detail, selected, waiting, forbidden, noScope } = board;
  if (board.login) return <PageState kind="login" />;

  return (
    <>
      <div className="list-card hr-dashboard-filters">
        <QueryFilters
          fields={dateFields}
          initial={{ asOf: today }}
          busy={read.loading || forbidden}
          submitDisabled={waiting}
          validate={({ asOf }) => validAsOf(asOf ?? '')}
          apply={({ asOf }) => board.apply(asOf!)}
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
          retry={canRetryRead(read.error) ? board.retry : undefined}
        />
      )}
      {noScope && <Alert type="info" message={report.noScope} />}
      {data && (
        <Metrics
          data={data}
          waiting={waiting}
          open={(metric) => board.changeDetail({ target: metric, asOf: data.asOf, page: 1 })}
        />
      )}
      {selected && (
        <BoardDetailDrawer
          title={selected.target.name}
          asOf={selected.asOf}
          read={detail}
          table={detail.data?.hasDataPermission ? detailTable(detail.data) : undefined}
          waiting={waiting}
          drawer={board.detailDrawer}
          changePage={(page) => board.changeDetail({ ...selected, page })}
          retry={() => board.changeDetail(selected)}
        />
      )}
    </>
  );
}

const boards = {
  management: ManagementBoard,
  structure: StructureBoard,
  movement: MovementBoard,
  process: ProcessBoard,
};

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
  const Board = boards[tab.path];
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
      <Board key={`${session.tenantId}/${session.identityKey}/${tab.path}`} today={today} refresh={refresh} />
    </section>
  );
}
