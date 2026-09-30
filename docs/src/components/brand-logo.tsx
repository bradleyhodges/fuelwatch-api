import Image from "next/image";
import fuelwatchLogoWhite from "@/app/assets/fuelwatch-api@white.svg";
import fuelwatchLogo from "@/app/assets/fuelwatch-api.svg";
import { cn } from "@/lib/cn";
import { appName } from "@/lib/shared";

/** CSS selects the supplied artwork before hydration, without a theme-dependent layout shift. */
export function BrandLogo({ prominent = false }: { prominent?: boolean }) {
    const imageSize = prominent ? "w-72 sm:w-80" : "w-48";
    return (
        <span className="inline-flex max-w-full shrink-0 p-1.5">
            <Image
                src={fuelwatchLogo}
                alt={appName}
                className={cn("block h-auto max-w-full dark:hidden", imageSize)}
                loading="eager"
                unoptimized
            />
            <Image
                src={fuelwatchLogoWhite}
                alt={appName}
                className={cn("hidden h-auto max-w-full dark:block", imageSize)}
                loading="eager"
                unoptimized
            />
        </span>
    );
}
