import { Alert, Button } from 'antd';
import { useParams } from 'react-router';
import { CONTRACT_BOARD_TOP_COMPANIES } from '@italent/domain';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { tenantDate } from '../foundation/dates.js';
import { ui } from '../foundation/messages.js';
import { AppliedFilters, QueryFilters } from '../hr-reports/ReportFilters.js';
import { m as report } from '../hr-reports/messages.js';
import type { Filters } from '../hr-reports/model.js';
import { BoardChart } from './BoardCharts.js';
import { BoardDetailDrawer } from './BoardDetailDrawer.js';
import { BoardGroupSelector } from './BoardGroupSelector.js';
import { ReadState } from './ReadState.js';
import { useContractFilterFields } from './ContractBoardFilters.js';
import {
  appliedContractFilters,
  contractCards,
  contractDetailTable,
  contractDetailUrl,
  contractOverviewUrl,
  initialContractFilters,
  validContractFilters,
  type ContractCard,
  type ContractDetail,
  type ContractOverview,
} from './contract-board-model.js';
import { m } from './messages.js';
import { canRetryRead } from './model.js';
import { useBoardRead } from './useBoardRead.js';
import '../hr-reports/hr-reports.css';
import './hr-dashboard.css';
import './hr-structure.css';
import './hr-contract-board.css';

interface Target {
  card: ContractCard;
  group?: string;
}

function Card({ card, open }: { card: ContractCard; open?: (group?: string) => void }) {
  const grouped = card.kind === 'groups';
  const caption = grouped ? m.peopleCount(card.text) : card.text;
  return (
    <article aria-label={card.name} className={grouped ? 'hr-structure-card' : 'hr-dashboard-metric'}>
      <h3>{card.name}</h3>
      <Button
        type="link"
        className="hr-contract-count"
        aria-label={`${m.viewDetails}：${caption}`}
        disabled={!open}
        onClick={() => open?.()}
      >
        <strong>{caption}</strong>
        <span>{m.viewDetails}</span>
      </Button>
      {card.code === 'signByCompany' && <p>{m.contract.topCompanies(CONTRACT_BOARD_TOP_COMPANIES)}</p>}
      {grouped && <BoardChart kind="bar" points={card.points} open={open} />}
    </article>
  );
}

function ContractSections({
  data,
  waiting,
  open,
}: {
  data: ContractOverview;
  waiting: boolean;
  open(target: Target, asOf: string): void;
}) {
  const cards = contractCards(data);
  const canOpen = data.hasDataPermission && !waiting;
  const renderCard = (card: ContractCard) => (
    <Card key={card.code} card={card} open={canOpen ? (group) => open({ card, group }, data.asOf) : undefined} />
  );
  return (
    <>
      <section className="hr-dashboard-section">
        <h2>{m.contract.changes}</h2>
        <p className="hr-contract-scope">{m.contract.changeScope}</p>
        <div className="hr-dashboard-cards">
          {cards.filter(({ code }) => code.startsWith('change')).map(renderCard)}
        </div>
      </section>
      <section className="hr-dashboard-section">
        <h2>{m.contract.signatures}</h2>
        <p className="hr-contract-scope">{m.contract.signingScope}</p>
        <div className="hr-contract-bars">{cards.filter(({ kind }) => kind === 'groups').map(renderCard)}</div>
        <p className="hr-contract-scope">{m.contract.expiringScope}</p>
        <div className="hr-dashboard-cards">{cards.filter(({ code }) => code === '3.1.17').map(renderCard)}</div>
      </section>
    </>
  );
}

function ContractBoard({ today, refresh }: { today: string; refresh(): void }) {
  const initial = initialContractFilters(today);
  const board = useBoardRead<Filters, Target, ContractOverview, ContractDetail>(
    initial,
    contractOverviewUrl,
    ({ target, asOf, page }, filters) => contractDetailUrl(target.card.code, { ...filters, asOf }, page, target.group),
  );
  const { data, read, detail, selected, waiting, forbidden, noScope } = board;
  const fields = useContractFilterFields(!forbidden && !board.login);
  if (board.login) return <PageState kind="login" />;
  const applied = data && appliedContractFilters(board.filters, data.asOf);
  const open = (target: Target, asOf: string) => board.changeDetail({ target, asOf, page: 1 });
  return (
    <>
      {!forbidden && (
        <div className="list-card hr-dashboard-filters">
          <QueryFilters
            fields={fields}
            initial={initial}
            busy={read.loading}
            applied={applied}
            submitDisabled={waiting}
            validate={(filters) => validContractFilters(filters, today)}
            apply={(filters) => board.apply({ ...filters, asOf: today })}
          />
          {data && <p className="hr-dashboard-date">{m.asOf(data.asOf)}</p>}
        </div>
      )}
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
      {data && <ContractSections data={data} waiting={waiting} open={open} />}
      {selected && (
        <BoardDetailDrawer
          title={selected.target.card.name}
          asOf={selected.asOf}
          read={detail}
          table={detail.data?.hasDataPermission ? contractDetailTable(detail.data) : undefined}
          missing={m.componentMissing}
          controls={
            data?.hasDataPermission &&
            applied && (
              <>
                <AppliedFilters fields={fields} applied={applied} />
                <BoardGroupSelector
                  target={selected.target}
                  disabled={waiting}
                  change={(group) =>
                    board.changeDetail({ ...selected, target: { ...selected.target, group }, page: 1 })
                  }
                />
              </>
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

export function HrContractBoardPage() {
  const session = useSession();
  const { refresh } = usePermissions();
  const suffix = useParams()['*'];
  if (suffix) return <PageState kind="not-found" />;
  const today = session.today ?? tenantDate(new Date(), session.timezone);
  return (
    <section className="list-page hr-dashboard hr-contract-board">
      <DecisionNote id="hr-contract-board" />
      <header className="page-heading">
        <h1>{m.contract.title}</h1>
      </header>
      <ContractBoard key={`${session.tenantId}/${session.identityKey}/${today}`} today={today} refresh={refresh} />
    </section>
  );
}
