import { Alert, Button, Space } from 'antd';
import { useState } from 'react';
import type { PersonnelReport } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { tenantDate } from '../foundation/dates.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { descriptions, m, movementDescriptions } from './messages.js';
import {
  cellText,
  errorText,
  initialFilters,
  movement,
  movementResultFilters,
  reportUrl,
  rosterFilters,
  rosterResultFilters,
  statistical,
  structureReport,
  supportsStatExport,
  type Column,
  type Filters,
  type ReportData,
  type ReportFailure,
  type Row,
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
type OrganizationStep = { id: string; label: string };

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
  const structure = structureReport(report.code);
  const isMovement = movement(report.code);
  const checksAccess = roster || structure || isMovement;
  const today = session.today ?? tenantDate(new Date(), session.timezone);
  const [initial] = useState(() => initialFilters(report.code, today));
  const [query, setQuery] = useState({ filters: initial, page: 1, generation: 0, trail: [] as OrganizationStep[] });
  const [exportFailure, setExportFailure] = useState<ReportFailure>();
  const [lastColumns, setLastColumns] = useState(noColumns);
  const parentId = query.trail.at(-1)?.id;
  const readFilters = parentId ? { ...query.filters, parentId } : query.filters;
  const read = useReportRead<ReportData>(reportUrl(report, readFilters, query.page), query.generation);
  const waiting = useReportRetryWait(Math.max(read.failure?.retryAt ?? 0, exportFailure?.retryAt ?? 0));
  const exportStatus = statusOf(exportFailure?.error);
  const readStatus = statusOf(read.error);
  const loginRequired = checksAccess && (readStatus === 401 || exportStatus === 401);
  const exportDenied = checksAccess && exportStatus === 403;
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
  const resultDate = structure && data && 'asOf' in data ? data.asOf : undefined;
  const responseFilters =
    isMovement && data && 'tables' in data
      ? movementResultFilters(query.filters, data)
      : resultDate
        ? { ...query.filters, asOf: resultDate }
        : query.filters;
  const applied = roster ? resultFilters : responseFilters;

  function request(filters: Filters, page: number, trail = query.trail) {
    if (waiting) return;
    setExportFailure(undefined);
    setQuery((current) => ({ filters, page, trail, generation: current.generation + 1 }));
  }

  function changePage(page: number) {
    if (statistical(report.code)) setQuery((current) => ({ ...current, page }));
    else request(applied ?? query.filters, page);
  }

  return {
    roster,
    structure,
    isMovement,
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
    departmentsAllowed: !exportDenied && readStatus !== 403,
    showHierarchy: !exportDenied && readStatus !== 403 && readStatus !== 404,
    canRetry: !checksAccess || readStatus === undefined || [0, 429, 500, 502, 503].includes(readStatus),
  };
}

function ReportContent({ report, title, back }: { report: PersonnelReport; title: string; back?: () => void }) {
  const result = useReportPage(report);
  const {
    roster,
    structure,
    isMovement,
    columns,
    initial,
    query,
    read,
    waiting,
    loginRequired,
    exportDenied,
    data,
    applied,
    resultFilters,
    exportFailure,
    request,
    canRetry,
    departmentsAllowed,
  } = result;
  if (loginRequired) return <PageState kind="login" />;

  const description = isMovement && !back ? movementDescriptions[report.code] : descriptions[report.code];
  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>{title}</h1>
        <ReportActions report={report} back={back} result={result} />
      </header>
      <div className="list-card hr-report-content">
        {description && <p>{description}</p>}
        {isMovement && back && <p>{m.movementHint}</p>}
        {roster && <p>{m.rosterPopulation}</p>}
        <ReportFilters
          code={report.code}
          initial={initial}
          columns={columns}
          busy={read.loading}
          blocked={waiting}
          applied={(structure || isMovement) && data ? applied : resultFilters}
          departments={
            structure || isMovement
              ? {
                  allowed: departmentsAllowed,
                  committed: query.filters,
                  object: structure ? 'HrStructureReport' : 'HrMovementReport',
                }
              : undefined
          }
          apply={(filters) => request(roster ? rosterFilters(filters, columns) : filters, 1, [])}
        />
        <ReportReadState
          loading={read.loading}
          error={read.error}
          waiting={waiting}
          retry={canRetry ? () => request(query.filters, query.page) : undefined}
        />
        {exportDenied && <Alert type="error" role="alert" message={errorText(exportFailure?.error, true)} />}
        <ReportResults code={report.code} result={result} />
      </div>
    </section>
  );
}

function ReportResults({ code, result }: { code: string; result: ReturnType<typeof useReportPage> }) {
  const { tenantId } = useSession();
  const { applied, changePage, data, filtersChanged, query, request, showHierarchy, waiting } = result;
  const flow = code === 'flow';
  const { trail } = query;

  function drill(next: OrganizationStep[]) {
    request(applied ?? query.filters, 1, next);
  }

  function renderOrganization({ _organizationId: id, _label: label }: Row) {
    if (typeof label !== 'string') return cellText('_label', label);
    // 服务端可能返回直属人员所在的本级行。已在路径上的组织不应重复进入。
    if (typeof id !== 'string' || id === tenantId || trail.some((step) => step.id === id)) return label;
    return (
      <Button type="link" size="small" disabled={waiting} onClick={() => drill([...trail, { id, label }])}>
        {label}
      </Button>
    );
  }

  return (
    <>
      {flow && showHierarchy && trail.length > 0 && (
        <OrganizationBreadcrumb trail={trail} waiting={waiting} navigate={drill} />
      )}
      {filtersChanged && <Alert type="info" role="status" message={m.filtersChanged} />}
      {data && !filtersChanged && (
        <>
          {data.hasDataPermission === false && <Alert type="info" message={m.noScope} />}
          <ReportTable
            code={code}
            data={data}
            page={query.page}
            paginationDisabled={waiting}
            drilled={trail.length > 0}
            renderLabel={flow ? renderOrganization : undefined}
            changePage={changePage}
          />
        </>
      )}
    </>
  );
}

function OrganizationBreadcrumb({
  trail,
  waiting,
  navigate,
}: {
  trail: OrganizationStep[];
  waiting: boolean;
  navigate(trail: OrganizationStep[]): void;
}) {
  const steps = [{ id: '', label: m.organization }, ...trail];
  return (
    <nav aria-label={m.organizationHierarchy}>
      <Space split={<span aria-hidden>/</span>}>
        {steps.map(({ id, label }, index) =>
          index === steps.length - 1 ? (
            <span key={id} aria-current="location">
              {label}
            </span>
          ) : (
            <Button
              key={id}
              type="link"
              size="small"
              disabled={waiting}
              onClick={() => navigate(trail.slice(0, index))}
            >
              {label}
            </Button>
          ),
        )}
      </Space>
    </nav>
  );
}

function ReportActions({
  report,
  back,
  result,
}: {
  report: PersonnelReport;
  back?: () => void;
  result: ReturnType<typeof useReportPage>;
}) {
  const { read, data, applied, waiting, exportDenied, exportFailure, setExportFailure } = result;
  const isStat = statistical(report.code);
  const permission = usePermissions(isStat ? undefined : 'TenantBase.HrRoster');
  const canExport = !permission.loading && !permission.error && permission.can('export', 'list');
  return (
    <Space>
      {back && <Button onClick={back}>{m.back}</Button>}
      {supportsStatExport(report.code) && data && applied && (
        <StatExport key={read.key} report={report} filters={applied} disabled={waiting} onFailure={setExportFailure} />
      )}
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
  );
}
