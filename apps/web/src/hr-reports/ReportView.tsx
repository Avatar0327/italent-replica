import { Alert, Button, Space } from 'antd';
import { useState } from 'react';
import type { PersonnelReport } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { tenantDate } from '../foundation/dates.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { descriptions, m } from './messages.js';
import {
  errorText,
  initialFilters,
  movement,
  reportUrl,
  rosterFilters,
  rosterResultFilters,
  statistical,
  type Column,
  type Filters,
  type ReportData,
  type ReportFailure,
} from './model.js';
import { ReportExport } from './ReportExport.js';
import { ReportFilters } from './ReportFilters.js';
import { ReportReadState, useReportRetryWait } from './ReportReadState.js';
import { ReportTable } from './ReportTable.js';
import { StatExport } from './StatExport.js';
import { useReportRead } from './useReportRead.js';
import './hr-reports.css';

const noColumns: Column[] = [];
const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);

export function ReportView({
  report,
  title = report.name,
  back,
}: {
  report: PersonnelReport;
  title?: string;
  back?: () => void;
}) {
  const session = useSession();
  return (
    <ReportContent
      key={JSON.stringify([session.tenantId, session.identityKey, report.code])}
      report={report}
      title={title}
      back={back}
    />
  );
}

function useReportPage(report: PersonnelReport) {
  const session = useSession();
  const roster = report.code === 'roster';
  const today = session.today ?? tenantDate(new Date(), session.timezone);
  const [initial] = useState(() => initialFilters(report.code, today));
  const [query, setQuery] = useState({ filters: initial, page: 1, generation: 0 });
  const [exportFailure, setExportFailure] = useState<ReportFailure>();
  const [lastColumns, setLastColumns] = useState(noColumns);
  const read = useReportRead<ReportData>(reportUrl(report, query.filters, query.page), query.generation);
  const waiting = useReportRetryWait(Math.max(read.failure?.retryAt ?? 0, exportFailure?.retryAt ?? 0));
  const exportStatus = statusOf(exportFailure?.error);
  const readStatus = statusOf(read.error);
  const loginRequired = roster && (readStatus === 401 || exportStatus === 401);
  const exportDenied = roster && exportStatus === 403;
  const data = exportDenied || loginRequired ? undefined : read.data;
  const rosterPage = roster && data && 'items' in data ? data : undefined;
  const reported = data && 'items' in data ? data.columns : undefined;

  // 同一权限周期内只保留表单所需的列元数据，便于修改失败的查询条件。
  const clearColumns = exportDenied || loginRequired || readStatus === 403 || readStatus === 404;
  const knownColumns = clearColumns ? noColumns : reported;
  if (roster && knownColumns && lastColumns !== knownColumns) setLastColumns(knownColumns);
  const columns = roster ? (knownColumns ?? lastColumns) : (reported ?? noColumns);
  const resultFilters = rosterPage ? rosterResultFilters(query.filters, rosterPage) : undefined;
  const filtersChanged = Boolean(rosterPage && !resultFilters);
  const applied = roster ? resultFilters : query.filters;

  function request(filters: Filters, page: number) {
    if (waiting) return;
    setExportFailure(undefined);
    setQuery((current) => ({ filters, page, generation: current.generation + 1 }));
  }

  function changePage(page: number) {
    if (statistical(report.code)) setQuery((current) => ({ ...current, page }));
    else request(applied ?? query.filters, page);
  }

  return {
    roster,
    columns,
    initial,
    query,
    read,
    waiting,
    loginRequired,
    exportDenied,
    data,
    filtersChanged,
    applied,
    resultFilters,
    exportFailure,
    setExportFailure,
    request,
    changePage,
    canRetry: !roster || readStatus === undefined || [0, 429, 502, 503].includes(readStatus),
  };
}

function ReportContent({ report, title, back }: { report: PersonnelReport; title: string; back?: () => void }) {
  const {
    roster,
    columns,
    initial,
    query,
    read,
    waiting,
    loginRequired,
    exportDenied,
    data,
    filtersChanged,
    applied,
    resultFilters,
    exportFailure,
    setExportFailure,
    request,
    changePage,
    canRetry,
  } = useReportPage(report);
  const permission = usePermissions('TenantBase.HrRoster');
  if (loginRequired) return <PageState kind="login" />;

  const isStat = statistical(report.code);
  const canExport = !permission.loading && !permission.error && permission.can('export', 'list');
  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>{title}</h1>
        <Space>
          {back && <Button onClick={back}>{m.back}</Button>}
          {isStat && data && <StatExport key={JSON.stringify(query)} report={report} filters={query.filters} />}
          {!isStat && data && applied && canExport && (
            <ReportExport
              key={read.key}
              report={report}
              filters={applied}
              disabled={waiting}
              onFailure={setExportFailure}
            />
          )}
          {!exportDenied && exportFailure && <span role="alert">{errorText(exportFailure.error, true)}</span>}
        </Space>
      </header>
      <div className="list-card hr-report-content">
        <p>{descriptions[report.code]}</p>
        {movement(report.code) && <p>{m.movementHint}</p>}
        {roster && <p>{m.rosterPopulation}</p>}
        <ReportFilters
          code={report.code}
          initial={initial}
          columns={columns}
          busy={read.loading}
          blocked={waiting}
          applied={resultFilters}
          apply={(filters) => request(roster ? rosterFilters(filters, columns) : filters, 1)}
        />
        <ReportReadState
          loading={read.loading}
          error={read.error}
          waiting={waiting}
          retry={canRetry ? () => request(query.filters, query.page) : undefined}
        />
        {exportDenied && <Alert type="error" role="alert" message={errorText(exportFailure?.error, true)} />}
        {filtersChanged && <Alert type="info" role="status" message={m.filtersChanged} />}
        {data && !filtersChanged && (
          <>
            {data.hasDataPermission === false && <Alert type="info" message={m.noScope} />}
            <ReportTable
              code={report.code}
              data={data}
              page={query.page}
              paginationDisabled={waiting}
              changePage={changePage}
            />
          </>
        )}
      </div>
    </section>
  );
}
