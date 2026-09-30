/**
 * Stage only SVG logos in the Worker's generated public tree before dev/deploy.
 * Source artwork stays with the integration. Fail early for dangling reference URLs;
 * remove only stale files in this script's output directory, never source artwork.
 */
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    unlink,
    writeFile,
} from "node:fs/promises";
import headers from "../src/asset-headers.json" with { type: "json" };

const source = new URL(
    "../../custom_components/fuelwatch_wa/assets/brands/",
    import.meta.url,
);
const output = new URL("../public/static/image/brand/", import.meta.url);
const registry = JSON.parse(
    await readFile(
        new URL(
            "../../custom_components/fuelwatch_wa/reference_data.json",
            import.meta.url,
        ),
        "utf8",
    ),
);
const files = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-z0-9_]+\.svg$/.test(entry.name))
    .map((entry) => entry.name);
for (const brand of registry.brands) {
    const name = brand.logo.match(
        /^\/static\/image\/brand\/([a-z0-9_]+\.svg)$/,
    )?.[1];
    if (!name || !files.includes(name))
        throw new Error(`Missing logo for brand code ${brand.code}`);
}
await mkdir(output, { recursive: true });
await Promise.all(
    files.map((name) => copyFile(new URL(name, source), new URL(name, output))),
);
for (const entry of await readdir(output, { withFileTypes: true })) {
    if (
        entry.isFile() &&
        /^[a-z0-9_]+\.svg$/.test(entry.name) &&
        !files.includes(entry.name)
    )
        await unlink(new URL(entry.name, output));
}
await writeFile(
    new URL("../public/_headers", import.meta.url),
    `/static/image/brand/*\n${Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join("\n")}\n`,
);
