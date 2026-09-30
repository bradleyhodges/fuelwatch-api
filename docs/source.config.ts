import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { stringifyReference } from "./src/lib/reference-markdown";

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
    dir: "content/docs",
    docs: {
        schema: pageSchema,
        postprocess: {
            includeProcessedMarkdown: { stringify: stringifyReference },
        },
    },
    meta: {
        schema: metaSchema,
    },
});

export default defineConfig({
    mdxOptions: {
        remarkStructureOptions: { stringify: { stringify: stringifyReference } },
    },
});
