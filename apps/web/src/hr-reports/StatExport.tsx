import { Button, Dropdown } from 'antd';
import type { PersonnelReport } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';
import { readReportFile, useReportFileDownload } from './report-file.js';
import { reportUrl, type ExportMode, type Filters, type ReportFailure } from './model.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 服务端文件名走 filename*（UTF-8 百分号编码）；取不到就用报表名，文件名规则 = 报表名.xlsx。 */
function fileNameOf(response: Response, fallback: string) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : fallback;
  } catch {
    return fallback;
  }
}
/** 三张统计报表的「下载▾」：两项（含公式 / 仅数据），用页面已运行的筛选；不做订阅与打印（DEC-809③）。 */
export function StatExport({
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
  const start = (mode: ExportMode) =>
    save(async (signal) => {
      const url = reportUrl(report, filters, undefined, true, mode);
      const response = await readReportFile(url, session.tenantId, signal, XLSX);
      const blob = await response.blob();
      if (!blob.size) throw new Error(m.exportFailed);
      return { blob, name: fileNameOf(response, `${report.name}.xlsx`) };
    });
  return (
    <Dropdown
      trigger={['click']}
      disabled={disabled || busy}
      menu={{
        items: [
          { key: 'formula', label: m.downloadFormula },
          { key: 'data', label: m.downloadData },
        ],
        onClick: ({ key }) => void start(key as ExportMode),
      }}
    >
      <Button loading={busy} disabled={disabled || busy}>
        {m.download} ▾
      </Button>
    </Dropdown>
  );
}
