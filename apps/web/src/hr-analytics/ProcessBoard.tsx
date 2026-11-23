import { Button } from 'antd';
import { APPROVAL_CATEGORIES, APPROVAL_CATEGORY_NAMES } from '@italent/domain';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { QueryFilters } from '../hr-reports/ReportFilters.js';
import { ReadOnlyReportTable } from '../hr-reports/ReportTable.js';
import { m as report } from '../hr-reports/messages.js';
import { cellText, pageSize, type Filters } from '../hr-reports/model.js';
import { organizationField, useCandidates, type OrgCandidate } from './BoardCandidates.js';
import { BoardChart, ChartItem } from './BoardCharts.js';
import { BoardDetailDrawer, BoardGroupSelector } from './BoardDetailDrawer.js';
import { BoardTrendChart } from './BoardTrendChart.js';
import { BoardReadFeedback, ReadState } from './ReadState.js';
import { m } from './messages.js';
import { asOfBounds, canRetryRead, organizationCandidatesUrl } from './model.js';
import {
  inFlightTable,
  isProcessRatio,
  isProcessStat,
  processDefaults,
  processDimension,
  processDrillLabel,
  processDetailTable,
  processDetailUrl,
  processMetrics,
  processOverviewUrl,
  processPoints,
  processResultFilters,
  processSections,
  processTrend,
  processUnavailable,
  validProcessFilters,
  type ProcessComponent,
  type ProcessDetail,
  type ProcessDrill,
  type ProcessOverview,
} from './process-model.js';
import { useBoardRead } from './useBoardRead.js';
import './hr-process.css';

const p = m.processBoard;
const dateFields = [
  { key: 'from', label: report.from, type: 'date', bounds: asOfBounds },
  { key: 'to', label: report.to, type: 'date', bounds: asOfBounds },
];
const categoryField = {
  key: 'category',
  label: p.category,
  options: APPROVAL_CATEGORIES.map((value) => ({ value, label: APPROVAL_CATEGORY_NAMES[value] })),
};

type Target = { component: ProcessComponent; filters: Filters; drill: ProcessDrill; pointKey?: string };
type ProcessRead = ReturnType<typeof useBoardRead<Filters, Target, ProcessOverview, ProcessDetail>>;
type OpenDrill = (drill: ProcessDrill, pointKey?: string) => void;

const trends = {
  inFlightByApprover: { kind: 'stacked', categoryWidth: 172, dimensionLabel: p.approverId },
  durationByWeek: { kind: 'line', categoryWidth: 95 },
  taskDurationByApprover: { kind: 'combo', categoryWidth: 172, dimensionLabel: p.approverId },
} as const;

function trendOf(component: ProcessComponent) {
  const known = trends[component.code as keyof typeof trends];
  if (known || !isProcessRatio(component)) return known;
  const dimensionLabel = processDimension(component);
  return {
    kind: 'combo',
    percent: true,
    categoryWidth: component.code === 'nonCompliantByWeek' ? 95 : 172,
    ...(dimensionLabel ? { dimensionLabel } : {}),
  } as const;
}

function ProcessChart({ component, open }: { component: ProcessComponent; open?: OpenDrill }) {
  const points = processPoints(component);
  const trend = trendOf(component);
  const data = trend && processTrend(component, points);
  const openPoint =
    open &&
    ((key: string) => {
      const point = (data ? data.series.flatMap((item) => item.points) : points).find((item) => item.key === key);
      if (point) open(point.drill, point.option ?? point.key);
    });
  if (trend && data) return <BoardTrendChart {...trend} {...data} open={openPoint} />;
  return <BoardChart kind="bar" points={points} open={openPoint} />;
}

function ProcessMetrics({ component, open }: { component: ProcessComponent; open?: OpenDrill }) {
  return (
    <div className="hr-process-metrics">
      {processMetrics(component).map(({ label, value, text = cellText('value', value), drill }) => {
        return (
          <ChartItem key={label} point={{ key: label, label, value, text }} open={open && drill && (() => open(drill))}>
            <span>{label}</span>
            <strong>{text}</strong>
          </ChartItem>
        );
      })}
    </div>
  );
}

function ProcessList({ board }: { board: ProcessRead }) {
  const { timezone } = useSession();
  const { inline, inlinePage, waiting, noScope, changeInlinePage } = board;
  if (inline.loading || inline.error) {
    return (
      <ReadState
        loading={inline.loading}
        error={inline.error}
        detail
        missing={m.componentMissing}
        waiting={waiting}
        retry={canRetryRead(inline.error) ? () => changeInlinePage(inlinePage) : undefined}
      />
    );
  }
  return (
    <ReadOnlyReportTable
      table={inFlightTable(inline.data, timezone)}
      page={inline.data?.page ?? inlinePage}
      pageSize={inline.data?.pageSize ?? pageSize}
      rowId="id"
      paginationDisabled={waiting || noScope}
      scrollY={360}
      changePage={changeInlinePage}
      emptyText={m.empty}
    />
  );
}

function ProcessCard({
  component,
  board,
  open,
}: {
  component: ProcessComponent;
  board: ProcessRead;
  open?: OpenDrill;
}) {
  const { code, name } = component;
  const list = code === 'inFlightList';
  const unavailable = processUnavailable(code);
  const metrics = isProcessStat(component);
  const chart = !list && !unavailable && (!metrics || code === 'inFlightAbnormal' || isProcessRatio(component));
  return (
    <article
      aria-label={name}
      className={`hr-structure-card${list || code === 'inFlightByApprover' ? ' hr-process-wide' : ''}${
        metrics ? ' hr-structure-stat' : ''
      }`}
    >
      <header>
        <h3>{name}</h3>
        {!list && !metrics && !unavailable && (
          <Button type="link" aria-label={m.viewDetails} disabled={!open} onClick={() => open?.({})}>
            {m.viewDetails}
          </Button>
        )}
      </header>
      {metrics && <ProcessMetrics component={component} open={open} />}
      {list && <ProcessList board={board} />}
      {unavailable && <p className="board-chart-empty">{m.statisticsUnavailable}</p>}
      {chart && <ProcessChart component={component} open={open} />}
    </article>
  );
}

function ProcessDetails({
  board,
  department,
}: {
  board: ProcessRead;
  department: ReturnType<typeof organizationField>;
}) {
  const { data, detail, selected, waiting } = board;
  if (!selected) return null;
  const { component, filters, pointKey, drill } = selected.target;
  const points = processPoints(component);
  // 比率组件换分组时保留分子 / 分母的命中条件，只改 group
  const kept = isProcessRatio(component) && drill.hit !== undefined ? { hit: drill.hit } : {};
  const category = categoryField.options.find(({ value }) => value === filters.category)?.label;
  const departmentText = filters.departmentId && department.appliedText?.(filters.departmentId, filters);
  return (
    <BoardDetailDrawer
      title={component.name}
      asOf={selected.asOf}
      read={detail}
      table={detail.data?.hasDataPermission ? processDetailTable(detail.data) : undefined}
      missing={m.componentMissing}
      controls={
        data?.hasDataPermission && (
          <>
            <p>
              {[
                p.window(filters.from!, filters.to!),
                category && `${p.category} ${category}`,
                departmentText,
                processDrillLabel(component, drill),
              ]
                .filter(Boolean)
                .join('，')}
            </p>
            <BoardGroupSelector
              options={points}
              group={pointKey}
              disabled={waiting}
              change={(key) => {
                const point = points.find((item) => item.key === key);
                board.changeDetail({
                  ...selected,
                  target: { ...selected.target, pointKey: point?.key, drill: { ...point?.drill, ...kept } },
                  page: 1,
                });
              }}
            />
          </>
        )
      }
      waiting={waiting}
      close={board.closeDetail}
      changePage={(page) => board.changeDetail({ ...selected, page })}
      retry={() => board.changeDetail(selected)}
    />
  );
}

export function ProcessBoard({ today, refresh }: { today: string; refresh(): void }) {
  const board = useBoardRead<Filters, Target, ProcessOverview, ProcessDetail>(
    processDefaults(today),
    processOverviewUrl,
    ({ target, page }) => processDetailUrl(target.component.code, target.filters, page, target.drill),
    (data, filters, page) =>
      data.components.some(({ code }) => code === 'inFlightList')
        ? processDetailUrl('inFlightList', processResultFilters(filters, data), page, {})
        : null,
  );
  const { data, read, waiting, forbidden, login } = board;
  const candidates = useCandidates<OrgCandidate>(
    forbidden || login ? null : organizationCandidatesUrl('HrProcessDashboard', data?.asOf ?? today),
  );
  const department = organizationField(candidates, 'departmentId', p.department, null);
  const applied = data && processResultFilters(board.filters, data);
  if (login) return <PageState kind="login" />;

  return (
    <>
      {!forbidden && (
        <div className="list-card hr-dashboard-filters">
          <QueryFilters
            fields={[...dateFields, categoryField, department]}
            initial={board.filters}
            busy={read.loading}
            submitDisabled={waiting}
            applied={applied}
            validate={validProcessFilters}
            apply={(filters) => board.apply({ ...filters, asOf: applied?.asOf ?? board.filters.asOf! })}
          />
        </div>
      )}
      <BoardReadFeedback board={board} refresh={refresh} />
      {data &&
        applied &&
        processSections(data.components).map(({ module, items }) => (
          <section key={module} className="hr-dashboard-section hr-process-section">
            <h2>{p[module]}</h2>
            <div className="hr-structure-grid">
              {items.map((component) => (
                <ProcessCard
                  key={component.code}
                  component={component}
                  board={board}
                  open={
                    data.hasDataPermission && !waiting
                      ? (drill, pointKey) =>
                          board.changeDetail({
                            target: { component, filters: applied, drill, pointKey },
                            asOf: data.asOf,
                            page: 1,
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        ))}
      <ProcessDetails board={board} department={department} />
    </>
  );
}
