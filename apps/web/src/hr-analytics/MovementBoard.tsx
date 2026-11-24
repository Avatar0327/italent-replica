import { Button } from 'antd';
import { useState } from 'react';
import { PageState } from '../foundation/PageState.js';
import { QueryFilters } from '../hr-reports/ReportFilters.js';
import { ReadOnlyReportTable } from '../hr-reports/ReportTable.js';
import { cellText, pageSize, type DisplayTable, type Filters } from '../hr-reports/model.js';
import { candidateUuid, organizationField, useCandidates, type OrgCandidate } from './BoardCandidates.js';
import { BoardChart } from './BoardCharts.js';
import { BoardDetailDrawer, BoardGroupSelector } from './BoardDetailDrawer.js';
import { BoardNestedPie } from './BoardNestedPie.js';
import { BoardTrendChart } from './BoardTrendChart.js';
import { BoardReadFeedback } from './ReadState.js';
import { m } from './messages.js';
import { memberDetailTable, organizationCandidatesUrl } from './model.js';
import {
  movementCards,
  movementDetailUrl,
  movementNeedsGroup,
  movementOverviewUrl,
  type MovementCard,
  type MovementDetail,
  type MovementOverview,
} from './movement-model.js';
import { useBoardRead } from './useBoardRead.js';
import './hr-movement.css';

type ChartCard = Extract<MovementCard, { options: unknown }>;
type Target = { card: Exclude<MovementCard, { body: 'unavailable' }>; group?: string; rowLabel?: string };

function EstablishmentTable({
  table,
  hasScope,
  open,
}: {
  table: DisplayTable;
  hasScope: boolean;
  open?: (group: string, label: string) => void;
}) {
  const [page, setPage] = useState(1);
  const current = hasScope ? table : { ...table, total: 0, rows: [] };
  return (
    <>
      <p className="hr-structure-chart-summary">{m.establishmentScope}</p>
      <div className="hr-movement-establishment">
        <ReadOnlyReportTable
          table={current}
          rows={current.rows.slice((page - 1) * pageSize, page * pageSize)}
          page={page}
          pageSize={pageSize}
          changePage={setPage}
          scrollY={360}
          rowId="key"
          emptyText={m.empty}
          renderCell={(key, value, row) =>
            key === 'count' && open ? (
              <Button
                type="link"
                size="small"
                aria-label={m.establishmentDetail(String(row.label), cellText(key, value))}
                onClick={() => open(String(row.key), String(row.label))}
              >
                {cellText(key, value)}
              </Button>
            ) : undefined
          }
        />
      </div>
    </>
  );
}

function MovementChart({ card, open }: { card: ChartCard; open?: (group?: string) => void }) {
  if ('series' in card)
    return (
      <BoardTrendChart
        kind={card.body}
        categories={card.categories}
        series={card.series}
        percent={card.percent}
        open={open}
      />
    );
  return (
    <>
      <p className="hr-structure-chart-summary">{m.peopleCount(cellText('count', card.total))}</p>
      {card.body === 'nested-pie' ? (
        <BoardNestedPie points={card.points} open={open} />
      ) : (
        <BoardChart kind={card.body} points={card.points} open={open} />
      )}
    </>
  );
}

function Card({
  card,
  hasScope,
  waiting,
  open,
}: {
  card: MovementCard;
  hasScope: boolean;
  waiting: boolean;
  open(target: Target): void;
}) {
  const allowed = hasScope && !waiting;
  const openGroup =
    allowed && 'options' in card && (!movementNeedsGroup(card.code) || card.options.length > 0)
      ? (group?: string) => open({ card, group })
      : undefined;
  let content;
  if (card.body === 'unavailable') {
    content = <p className="board-chart-empty">{card.text}</p>;
  } else if (card.body === 'table') {
    content = (
      <EstablishmentTable
        table={card.table}
        hasScope={hasScope}
        open={allowed ? (group, rowLabel) => open({ card, group, rowLabel }) : undefined}
      />
    );
  } else {
    content = <MovementChart card={card} open={openGroup} />;
  }
  return (
    <article
      className={`hr-structure-card hr-movement-${card.body}${card.code === '6.28' ? ' hr-movement-rate' : ''}`}
      aria-label={card.name}
    >
      <header>
        <h2>{card.name}</h2>
        {'options' in card && (
          <Button type="link" aria-label={m.viewDetails} disabled={!openGroup} onClick={() => openGroup?.()}>
            {m.viewDetails}
          </Button>
        )}
      </header>
      {content}
    </article>
  );
}

type MovementRead = ReturnType<typeof useBoardRead<Filters, Target, MovementOverview, MovementDetail>>;

function MovementDetails({ board, departmentText }: { board: MovementRead; departmentText?: string }) {
  const { data, detail, selected, waiting } = board;
  if (!selected) return null;
  return (
    <BoardDetailDrawer
      title={selected.target.card.name}
      asOf={selected.asOf}
      read={detail}
      table={detail.data?.hasDataPermission ? memberDetailTable(detail.data) : undefined}
      missing={m.componentMissing}
      controls={
        data?.hasDataPermission && (
          <>
            {departmentText && <p>{departmentText}</p>}
            {'options' in selected.target.card ? (
              <BoardGroupSelector
                options={selected.target.card.options}
                group={selected.target.group}
                required={movementNeedsGroup(selected.target.card.code)}
                disabled={waiting}
                change={(group) => board.changeDetail({ ...selected, target: { ...selected.target, group }, page: 1 })}
              />
            ) : (
              <p>{selected.target.rowLabel}</p>
            )}
          </>
        )
      }
      waiting={waiting}
      drawer={board.detailDrawer}
      changePage={(page) => board.changeDetail({ ...selected, page })}
      retry={() => board.changeDetail(selected)}
    />
  );
}

export function MovementBoard({ today, refresh }: { today: string; refresh(): void }) {
  const board = useBoardRead<Filters, Target, MovementOverview, MovementDetail>(
    { asOf: today },
    movementOverviewUrl,
    ({ target, asOf, page }, filters) => movementDetailUrl(target.card.code, { ...filters, asOf }, page, target.group),
  );
  const { data, read, waiting, forbidden } = board;
  const asOf = data?.asOf ?? board.filters.asOf ?? today;
  const candidates = useCandidates<OrgCandidate>(
    forbidden || board.login ? null : organizationCandidatesUrl('HrMovement', asOf),
  );
  const department = organizationField(candidates, 'departmentId', m.movementDepartment);
  const appliedDepartment = data && board.filters.departmentId;
  if (board.login) return <PageState kind="login" />;

  return (
    <>
      <div className="list-card hr-dashboard-filters">
        {!forbidden && (
          <QueryFilters
            fields={[department]}
            initial={{}}
            applied={appliedDepartment ? board.filters : undefined}
            busy={read.loading}
            submitDisabled={waiting}
            validate={({ departmentId }) => !departmentId || candidateUuid.test(departmentId)}
            apply={(filters) => board.apply({ ...filters, asOf })}
          />
        )}
        {data && <p className="hr-dashboard-date">{m.asOf(data.asOf)}</p>}
      </div>
      <div className="list-card hr-dashboard-scope">
        <p>{m.movementScope}</p>
      </div>
      <BoardReadFeedback board={board} refresh={refresh} />
      {data && (
        <div className="hr-structure-grid">
          {movementCards(data).map((card) => (
            <Card
              key={card.code}
              card={card}
              hasScope={data.hasDataPermission}
              waiting={waiting}
              open={(target) => board.changeDetail({ target, asOf: data.asOf, page: 1 })}
            />
          ))}
        </div>
      )}
      <MovementDetails
        board={board}
        departmentText={appliedDepartment ? department.appliedText?.(appliedDepartment, board.filters) : undefined}
      />
    </>
  );
}
