import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { docsSearchOptions } from "@/lib/search";
import { appName, siteUrl } from "@/lib/shared";
import Head from "next/head";

const inter = Inter({
    subsets: ["latin"],
});

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: { default: appName, template: "%s | FuelWatch API" },
    description:
        "Public JSON:API documentation for Western Australian fuel prices, station details and reference codes.",
    authors: [{ name: "Bradley Hodges", url: "https://github.com/bradleyhodges" }, { name: "FuelWatch", url: "https://fuelwatch.wa.gov.au" }],
    keywords: ["FuelWatch", "FuelWatch API", "API", "JSON:API", "Western Australia", "Fuel Prices API", "FuelWatch REST API"],
    applicationName: appName,
    openGraph: {
        title: appName,
        description: "Public JSON:API documentation for Western Australian fuel prices, station details and reference codes.",
    },
    icons: {
        icon: "/favicon.ico",
        apple: "/apple-touch-icon.png",
        other: [
            { url: "/favicon-32x32.png", sizes: "32x32" },
            { url: "/favicon-16x16.png", sizes: "16x16" },
        ],
    },
    manifest: "/manifest.webmanifest",
    alternates: {
        canonical: siteUrl,
    },
};

export default function Layout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en" className={inter.className} suppressHydrationWarning>
            <Head>
                <link rel="icon" type="image/x-icon" href="favicon.ico" />
                <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
                <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
                <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
                <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
            </Head>

            <body className="flex min-h-screen flex-col">
                <RootProvider search={docsSearchOptions}>{children}</RootProvider>
            </body>
        </html>
    );
}
