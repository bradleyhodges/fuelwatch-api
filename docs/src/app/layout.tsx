import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { docsSearchOptions } from "@/lib/search";
import { appName, siteUrl } from "@/lib/shared";

const inter = Inter({
    subsets: ["latin"],
});

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: { default: appName, template: "%s | FuelWatch API" },
    description:
        "Public JSON:API documentation for Western Australian fuel prices, station details and reference codes.",
};

export default function Layout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en" className={inter.className} suppressHydrationWarning>
            <body className="flex min-h-screen flex-col">
                <RootProvider search={docsSearchOptions}>{children}</RootProvider>
            </body>
        </html>
    );
}
