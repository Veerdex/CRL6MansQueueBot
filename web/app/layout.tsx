import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import SoundToggle from "@/components/SoundToggle";
import { getActiveSeason } from "@/lib/leaderboard/queries";
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
  title: "CRL West 6 Mans",
  description: "Leaderboard for the CRL 6 Mans Rocket League pickup community",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const activeSeason = await getActiveSeason();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="panel-nav sticky top-0 z-40">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <Link href="/" className="text-lg font-bold tracking-tight text-foreground hover:opacity-80 transition-opacity">
                CRL <span className="text-accent-secondary">West</span> <span className="text-accent">6 Mans</span>
                {activeSeason && (
                  <span className="text-muted ml-2">
                    - Season {activeSeason.season_number}
                  </span>
                )}
              </Link>
              <Link href="/info" className="text-muted hover:text-foreground transition-opacity hover:opacity-80">
                Info
              </Link>
              <Link href="/match-times" className="text-muted hover:text-foreground transition-opacity hover:opacity-80">
                Match Times
              </Link>
            </div>
            <SoundToggle />
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
