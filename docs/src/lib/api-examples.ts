import specification from "../../public/openapi.json";

export type ApiExampleName = keyof typeof specification.components.examples;

/** Request the example's selection; retain relative day filters so the command stays usable. */
export function getExampleRequest(name: ApiExampleName): string {
    const example = specification.components.examples[name];
    const capture = "x-capture" in example ? example["x-capture"] : example["x-derived-from"];
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
    const example = specification.components.examples[name];
    if (!("x-capture" in example)) {
        return `Derived from production data captured ${example["x-derived-from"].sourceCapturedAt} (AWST). Product values expanded locally; this is not a captured production response.`;
    }
    const capture = example["x-capture"];
    return `Captured ${capture.capturedAt} (AWST) · HTTP ${capture.status}. Historical snapshot; repeat the request for current data.`;
}
