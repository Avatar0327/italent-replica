import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "人才管理系统",
  description: "组织、员工与审批工作台",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
