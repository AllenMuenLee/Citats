import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@ai-browser/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-Native Browser",
  description: "Desktop renderer for the AI-Native Browser (Electron app, Next.js renderer).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
