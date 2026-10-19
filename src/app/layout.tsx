import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Inter({ variable: "--font-ui", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-num", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  title: "TradeD",
  description: "TradeD trading terminal. Practice orders stay virtual and are never sent to an exchange.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e13" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <body className="h-full bg-background text-text">
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("td-theme");if(t!=="light"&&t!=="dark")t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
