import type { ReactNode } from 'react';
import { ViewHeading } from '../foundation/ViewHeading.js';
import './reference-view.css';

// 业务页保留工具栏位置，图标与视图切换直接复用 FE-0。
export function ReferenceFrame({ children }: { children: ReactNode }) {
  return <div className="r1c-reference">{children}</div>;
}
export function ReferenceView({
  title,
  choices,
  onChange,
  actions,
}: {
  title: string;
  choices: { key: string; label: string }[];
  onChange(key: string): void;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <ViewHeading
        title={title}
        view={{ value: choices.find((choice) => choice.label === title)?.key ?? '', options: choices, onChange }}
      />
      {actions}
    </header>
  );
}
