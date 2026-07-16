import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CRL 6 Mans",
  description: "Leaderboard for the CRL 6 Mans Rocket League pickup community",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-brand-blue/10 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3 text-sm">
            <span className="mr-4 text-lg font-bold tracking-tight text-brand-blue dark:text-white">
              CRL <span className="text-brand-orange">6 Mans</span>
            </span>
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 font-medium text-zinc-600 transition-colors hover:bg-brand-blue/5 hover:text-brand-blue dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Main
            </Link>
            <Link
              href="/stats/season"
              className="rounded-full px-3 py-1.5 font-medium text-zinc-600 transition-colors hover:bg-brand-blue/5 hover:text-brand-blue dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Season Stats
            </Link>
            <Link
              href="/stats/all-time"
              className="rounded-full px-3 py-1.5 font-medium text-zinc-600 transition-colors hover:bg-brand-blue/5 hover:text-brand-blue dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              All-Time Stats
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
