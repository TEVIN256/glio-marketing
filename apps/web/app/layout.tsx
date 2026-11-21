import type { Metadata } from "next";
import { getDict } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "GLIO | غليو",
  description: "GLIO: ad operators and AI agents for Saudi businesses. Paid ads, tracking and SEO, with reconciled numbers and Arabic reports.",
};

/** Page shell only. The public website and the app each add their own header in their route group. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, dir } = await getDict();
  return (
    <html lang={lang} dir={dir}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
