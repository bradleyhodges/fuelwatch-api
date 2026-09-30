import { fileURLToPath } from "node:url";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
    plugins: await mdx(),
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            collections: fileURLToPath(new URL("./.source", import.meta.url)),
        },
    },
    test: {
        environment: "node",
    },
}));
