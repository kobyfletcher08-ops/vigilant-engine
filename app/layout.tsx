import type { Metadata } from "next";
import "./globals.css";
import "./market.css";

export const metadata: Metadata = {
  title: "DEX Arbitrage Console",
  description: "Discover Solana, BSC and Arbitrum One pools with DEX Screener, track gainers and review atomic arbitrage transactions with your own wallet.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
