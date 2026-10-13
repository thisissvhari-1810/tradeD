import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "TradeD",
  description: "TradeD trading terminal. Practice orders stay virtual. Market data uses the configured TradeM provider.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${sans.variable} ${mono.variable} h-full`}>
      <body className="h-full bg-background text-text">
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("td-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else document.documentElement.dataset.theme="light";}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
