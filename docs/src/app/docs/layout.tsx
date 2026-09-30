import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
    return (
        <DocsLayout
            tree={source.getPageTree()}
            sidebar={{
                tabs: {
                    transform(option, node) {
                        const meta = source.getNodeMeta(node);
                        if (!meta || !node.icon) return option;

                        const color = `var(--${
                            meta.path.split("/")[0]
                        }-color, var(--color-fd-foreground))`;

                        return {
                            ...option,
                            icon: (
                                <div
                                    className="size-full rounded-lg max-md:border max-md:bg-(--tab-color)/10 max-md:p-1.5 [&_svg]:size-full"
                                    style={
                                        {
                                            color,
                                            "--tab-color": color,
                                        } as CSSProperties
                                    }
                                >
                                    {node.icon}
                                </div>
                            ),
                        };
                    },
                },
            }}
            {...baseOptions()}
        >
            {children}
        </DocsLayout>
    );
}
