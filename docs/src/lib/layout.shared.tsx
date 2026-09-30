import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BrandLogo } from "@/components/brand-logo";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            title: <BrandLogo />,
        },
        githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    };
}
