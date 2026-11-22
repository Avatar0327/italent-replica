import { Alert, Button } from 'antd';
import { HR_STRUCTURE_TOP_INSTITUTIONS } from '@italent/domain';
import { PageState } from '../foundation/PageState.js';
import { ui } from '../foundation/messages.js';
import { m as report } from '../hr-reports/messages.js';
import { cellText, type Filters } from '../hr-reports/model.js';
import { BoardChart, MapPlaceholder } from './BoardCharts.js';
import { BoardDetailDrawer } from './BoardDetailDrawer.js';
import { BoardGroupSelector } from './BoardGroupSelector.js';
import { ReadState } from './ReadState.js';
import { StructureFilters } from './StructureFilters.js';
import { m } from './messages.js';
import { canRetryRead } from './model.js';
import {
  structureCards,
  structureDetailTable,
  structureDetailUrl,
  structureOverviewUrl,
  type StructureCard,
  type StructureDetail,
  type StructureOverview,
} from './structure-model.js';
import { useBoardRead } from './useBoardRead.js';
import './hr-structure.css';

interface StructureTarget {
  card: StructureCard;
  group?: string;
}

function Card({ card, open }: { card: StructureCard; open?: (group?: string) => void }) {
  const { code, name, body, text, points, ratio, wholeCount } = card;
  const count = cellText('value', wholeCount);
  let content;
  if (body === 'map') {
    content = <MapPlaceholder />;
  } else if (body === 'stat') {
    content = (
      <>
        <strong>{text}</strong>
        {code !== '6.01' && <span>{m.rawDetailCount(count)}</span>}
      </>
    );
  } else {
    content = (
      <>
        <p className="hr-structure-chart-summary">
          {ratio ? m.hitCount(count) : m.peopleCount(count)}
          {code === '6.04' && ` · ${m.topInstitutions(HR_STRUCTURE_TOP_INSTITUTIONS)}`}
        </p>
        <BoardChart kind={body} points={points} maximum={ratio ? 1 : undefined} open={open} />
      </>
    );
  }
  return (
    <article className={`hr-structure-card hr-structure-${body}`} aria-label={name}>
      <header>
        <h2>{name}</h2>
        {body !== 'map' && (
          <Button type="link" aria-label={m.viewDetails} disabled={!open} onClick={() => open?.()}>
            {m.viewDetails}
          </Button>
        )}
      </header>
      {content}
    </article>
  );
}

export function StructureBoard({ today, refresh }: { today: string; refresh(): void }) {
  const board = useBoardRead<Filters, StructureTarget, StructureOverview, StructureDetail>(
    { asOf: today },
    structureOverviewUrl,
    ({ target, asOf, page }, filters) => structureDetailUrl(target.card.code, { ...filters, asOf }, page, target.group),
  );
  const { data, read, detail, selected, waiting, forbidden, noScope } = board;
  if (board.login) return <PageState kind="login" />;
  return (
    <>
      <div className="list-card hr-dashboard-filters">
        <StructureFilters
          asOf={data?.asOf ?? board.filters.asOf ?? today}
          applied={data && { ...board.filters, asOf: data.asOf }}
          busy={read.loading}
          forbidden={forbidden}
          waiting={waiting}
          apply={board.apply}
        />
        {data && <p className="hr-dashboard-date">{m.asOf(data.asOf)}</p>}
      </div>
      <div className="list-card hr-dashboard-scope">
        <p>{m.structureScope}</p>
      </div>
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
        <div className="hr-structure-grid">
          {structureCards(data).map((card) => (
            <Card
              key={card.code}
              card={card}
              open={
                !waiting && data.hasDataPermission && card.body !== 'map'
                  ? (group) => board.changeDetail({ target: { card, group }, asOf: data.asOf, page: 1 })
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {selected && (
        <BoardDetailDrawer
          title={selected.target.card.name}
          asOf={selected.asOf}
          read={detail}
          table={detail.data?.hasDataPermission ? structureDetailTable(detail.data) : undefined}
          missing={m.componentMissing}
          controls={
            data?.hasDataPermission && (
              <BoardGroupSelector
                target={selected.target}
                disabled={waiting}
                change={(group) => board.changeDetail({ ...selected, target: { ...selected.target, group }, page: 1 })}
              />
            )
          }
          waiting={waiting}
          close={board.closeDetail}
          changePage={(page) => board.changeDetail({ ...selected, page })}
          retry={() => board.changeDetail(selected)}
        />
      )}
    </>
  );
}
