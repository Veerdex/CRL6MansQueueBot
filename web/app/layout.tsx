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
          <div className="mx-auto flex max-w-4xl items-center px-4 py-3 text-sm">
            <Link href="/" className="text-lg font-bold tracking-tight text-brand-blue dark:text-white hover:opacity-80 transition-opacity">
              CRL <span className="text-brand-orange">6 Mans</span>
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
