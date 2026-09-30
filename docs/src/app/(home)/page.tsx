import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";

const features = [
    {
        title: "One station, multiple fuels",
        description:
            "Read grouped product prices in Australian cents per litre, with explicit AWST price periods.",
    },
    {
        title: "Compact by default",
        description:
            "Use stable brand, feature and restriction codes. Expand the fields you need into named objects.",
    },
    {
        title: "Shared price snapshots",
        description:
            "Hourly source refreshes and bounded caching reduce repeated requests to FuelWatch.",
    },
    {
        title: "A documented HTTP contract",
        description:
            "Use JSON:API resources, conditional requests and a downloadable OpenAPI specification.",
    },
];

export default function HomePage() {
    return (
        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-1 flex-col justify-center px-6 py-20 md:py-28">
            <div className="mb-6">
                <BrandLogo prominent />
            </div>
            <h1 className="mb-5 font-semibold text-4xl text-fd-foreground tracking-tight md:text-5xl">
                Western Australian fuel prices{" "}
                <span className="font-normal text-fd-muted-foreground">
                    for your next integration
                </span>
            </h1>
            <p className="mb-10 max-w-2xl text-fd-muted-foreground text-lg leading-relaxed">
                Read service stations, compare published fuel prices and use normalized station
                details through a public, read-only API. No account or API key required.
            </p>
            <div className="mb-12 flex flex-wrap gap-3">
                <Link
                    href="/docs/getting-started"
                    className="inline-flex h-10 items-center rounded-lg bg-fd-primary px-5 font-semibold text-[14px] text-fd-primary-foreground transition-opacity hover:opacity-90"
                >
                    Get started
                </Link>
                <Link
                    href="/docs/api-reference"
                    className="inline-flex h-10 items-center rounded-lg border border-fd-border px-5 font-medium text-[14px] text-fd-foreground transition-colors hover:bg-fd-muted"
                >
                    API reference
                </Link>
                <a
                    href="/openapi.json"
                    className="inline-flex h-10 items-center rounded-lg border border-fd-border px-5 font-medium text-[14px] text-fd-foreground transition-colors hover:bg-fd-muted"
                >
                    OpenAPI specification
                </a>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                {features.map((feature) => (
                    <div
                        key={feature.title}
                        className="rounded-lg border border-fd-border p-5 transition-colors hover:bg-fd-muted/40"
                    >
                        <h2 className="mb-1.5 font-semibold text-[14px] text-fd-foreground">
                            {feature.title}
                        </h2>
                        <p className="text-[14px] text-fd-muted-foreground leading-relaxed">
                            {feature.description}
                        </p>
                    </div>
                ))}
            </div>
            <div className="mt-12 border-fd-border border-t pt-10">
                <h2 className="mb-4 font-semibold text-[13px] text-fd-muted-foreground uppercase tracking-widest">
                    Your first request
                </h2>
                <pre className="overflow-x-auto rounded-lg border border-fd-border bg-fd-muted/50 px-5 py-3 font-mono text-[13px] text-fd-foreground">
                    {"curl 'https://fuelwatch.oss.bhodges.me/v1?product=1&expand=brand'"}
                </pre>
                <p className="mt-5 text-sm text-fd-muted-foreground">
                    An independent project by Bradley Hodges. Price data comes from{" "}
                    <a
                        className="underline underline-offset-4"
                        href="https://www.fuelwatch.wa.gov.au"
                    >
                        FuelWatch WA
                    </a>
                    .
                </p>
            </div>
        </div>
    );
}
