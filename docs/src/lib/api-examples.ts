import specification from "../../public/openapi.json";

export type ApiExampleName = keyof typeof specification.components.examples;

/** Reproduce the captured GET selection; retain relative day filters so the command stays usable. */
export function getExampleRequest(name: ApiExampleName): string {
    const capture = specification.components.examples[name]["x-capture"];
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return [
        `curl ${quote(capture.url)}`,
        ...Object.entries(capture.requestHeaders).map(
            ([key, value]) => `  -H ${quote(`${key}: ${value}`)}`,
        ),
    ].join(" \\\n");
}

/** Keep capture time distinct from the source-price and provider-fetch timestamps in the payload. */
export function getExampleCaption(name: ApiExampleName): string {
    const capture = specification.components.examples[name]["x-capture"];
    return `Captured ${capture.capturedAt} (AWST) · HTTP ${capture.status}. Historical snapshot; repeat the request for current data.`;
}
