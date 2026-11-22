import { Button } from 'antd';
import type { PersonnelReport } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';
import { reportUrl, type Filters, type ReportFailure } from './model.js';
import { readReportFile, useReportFileDownload } from './report-file.js';
export function ReportExport({
  report,
  filters,
  disabled,
  onFailure,
}: {
  report: PersonnelReport;
  filters: Filters;
  disabled: boolean;
  onFailure(failure?: ReportFailure): void;
}) {
  const session = useSession();
  const { busy, save } = useReportFileDownload(disabled, onFailure);
  const start = () =>
    save(async (signal) => {
      const url = reportUrl(report, filters, undefined, true);
      const response = await readReportFile(url, session.tenantId, signal, 'text/csv');
      return { blob: await response.blob(), name: `report-${report.code}.csv` };
    });
  return (
    <Button loading={busy} disabled={disabled || busy} onClick={() => void start()}>
      {m.export}
    </Button>
  );
}
