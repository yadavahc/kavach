import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "Kavach Live · scam-call interception on your device",
  description:
    "Voices can be cloned. Scripts can't be hidden. Kavach Live matches the live call transcript against scam playbooks with sub-millisecond on-device Moss retrieval and warns before the money leaves.",
};

export const viewport: Viewport = {
  themeColor: "#07080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-ink font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
