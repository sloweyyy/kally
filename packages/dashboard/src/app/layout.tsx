import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kally Dashboard",
  description: "Real-time monitoring for the Product Support AI Teammate",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
