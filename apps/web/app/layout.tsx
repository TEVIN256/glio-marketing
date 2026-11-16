import type { Metadata } from "next";
import { getDict } from "@/lib/i18n";
import { switchLanguage } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glio | غليو",
  description: "Arabic-first ad reporting for Saudi businesses and agencies",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, t, dir } = await getDict();
  return (
    <html lang={lang} dir={dir}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap"
        />
      </head>
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            {t.appName}
          </a>
          <div className="topbar-actions">
            <form action={switchLanguage}>
              <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
              <button className="secondary" type="submit" lang={lang === "ar" ? "en" : "ar"}>
                {t.switchLang}
              </button>
            </form>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
