import type { RootProviderProps } from "fumadocs-ui/provider/next";

export const docsSearchOptions = {
    options: {
        api: "/api/search",
        type: "static",
    },
} satisfies NonNullable<RootProviderProps["search"]>;
