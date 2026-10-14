import { Alert } from 'antd';
import { useState } from 'react';
import { m } from './messages.js';
import type { GrantReceipt, LicenseOverage } from './model.js';

/** DEC-143：超额是成功回执，提醒放在页面层，不能随授权表单关闭而丢失。 */
export function useGrantReceipt() {
  const [overage, setOverage] = useState<LicenseOverage | null>(null);
  return {
    accept({ licenseOverage }: GrantReceipt) {
      setOverage(licenseOverage?.code === 'LICENSE_OVERAGE' && licenseOverage.balance < 0 ? licenseOverage : null);
    },
    notice: overage ? (
      <Alert
        type="warning"
        showIcon
        message={m.licenseOverageTitle}
        description={m.licenseOverageDetail(overage.licenseType, overage.balance)}
      />
    ) : null,
  };
}
