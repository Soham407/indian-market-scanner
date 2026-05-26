import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bot Dashboard",
  description: "Auto paper-trading bot status dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
