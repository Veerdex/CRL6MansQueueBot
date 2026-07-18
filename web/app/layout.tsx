import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import SoundToggle from "@/components/SoundToggle";
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
        <nav className="panel-nav sticky top-0 z-40">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 text-sm">
            <Link href="/" className="text-lg font-bold tracking-tight text-foreground hover:opacity-80 transition-opacity">
              CRL <span className="text-accent">6 Mans</span>
            </Link>
            <SoundToggle />
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
