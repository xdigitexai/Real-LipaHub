import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LipaHub AI — Intelligent earning automation",
  description:
    "LipaHub AI connects workers with legitimate online earning opportunities and businesses with affordable digital work — evaluated and verified by an AI automation engine with human oversight.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
