"use client";

import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

export const CopyTextInline = ({
    text,
    children,
    className,
}: {
    text: string;
    children?: React.ReactNode;
    className?: string;
}) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        // Blur the element
        (document.activeElement as HTMLElement)?.blur();

        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            className={cn(
                "group inline-flex origin-left cursor-pointer items-center gap-0.5 transition-all will-change-transform focus:scale-95",
                className,
            )}
        >
            {children}
            <div className="flex w-0 items-center justify-center leading-none opacity-0 blur-sm transition-all group-hover:ml-0.5 group-hover:w-5 group-hover:text-blue-600 group-hover:opacity-100 group-hover:blur-none">
                {copied ? (
                    <CheckIcon className="size-3.5 text-green-600" strokeWidth={3} />
                ) : (
                    <ClipboardIcon className="size-4 opacity-100" />
                )}
            </div>
        </button>
    );
};
