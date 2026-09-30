import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import defaultMdxComponents from "fumadocs-ui/mdx";
import {
    BracesIcon,
    FileBracesCornerIcon,
    ForwardIcon,
    Link2Icon,
    type LucideIcon,
    MinusIcon,
    PlusIcon,
    ReplyIcon,
} from "lucide-react";
import type { MDXComponents } from "mdx/types";
import {
    Children,
    type ComponentProps,
    cloneElement,
    isValidElement,
    type ReactElement,
    type ReactNode,
} from "react";
import { CopyTextInline } from "@/components/copy-text-inline";
import { cn } from "@/lib/cn";
import { type JsonHighlightToken, tokenizeJsonForHighlight } from "@/lib/json-highlight";
import {
    buildReferenceExample,
    findReferenceShape,
    getFieldEnumValues,
    getReferenceShape,
    groupDottedReferenceFields,
    type ReferenceEnumValue,
    type ReferenceShapeField,
    tokenizeReferenceType,
} from "@/lib/reference-types";
import specification from "../../public/openapi.json";

type ReferenceField = {
    allowedValues?: string[];
    children?: ReferenceField[];
    defaultValue?: string;
    description: ReactNode;
    enumValues?: readonly ReferenceEnumValue[];
    name: string;
    required?: boolean;
    type: string;
};

type MethodRow = {
    description?: ReactNode;
    name: string;
    parameters: string;
    returns: string;
};

type ServiceRow = {
    methods: string;
    service: string;
};

type FieldTableProps = {
    examplePlacement?: "inline" | "none";
    fields: ReferenceField[];
    title?: string;
};

type ReferenceExample = {
    key: string;
    title: string;
    value: Record<string, unknown>;
};

const maxFieldExpansionDepth = 1;
const maxVisibleChildFields = 30;

const jsonTokenClassName: Record<JsonHighlightToken["kind"], string> = {
    boolean: "text-violet-600 dark:text-violet-300",
    key: "text-sky-700 dark:text-sky-300",
    null: "text-rose-600 dark:text-rose-300",
    number: "text-amber-700 dark:text-amber-300",
    plain: "",
    punctuation: "text-fd-muted-foreground/80",
    string: "text-emerald-700 dark:text-emerald-300",
};

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}

function hashString(value: string): string {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(31, hash) + value.charCodeAt(index);
    }

    return Math.abs(hash).toString(36);
}

function MethodBadge({ method }: { method: string }) {
    const normalized = method.toUpperCase();

    return (
        <span
            className={cn(
                "inline-flex h-6.5 shrink-0 items-center rounded px-1.75 font-bold font-mono text-sm uppercase leading-none tracking-wide",
                normalized === "GET" &&
                    "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80 ring-inset dark:bg-emerald-950/30 dark:text-emerald-400 dark:ring-emerald-800/60",
                normalized === "POST" &&
                    "bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 ring-inset dark:bg-blue-950/30 dark:text-blue-400 dark:ring-blue-800/60",
                normalized === "PATCH" &&
                    "bg-amber-50 text-amber-700 ring-1 ring-amber-200/80 ring-inset dark:bg-amber-950/30 dark:text-amber-400 dark:ring-amber-800/60",
                normalized === "PUT" &&
                    "bg-violet-50 text-violet-700 ring-1 ring-violet-200/80 ring-inset dark:bg-violet-950/30 dark:text-violet-400 dark:ring-violet-800/60",
                normalized === "DELETE" &&
                    "bg-red-50 text-red-700 ring-1 ring-red-200/80 ring-inset dark:bg-red-950/30 dark:text-red-400 dark:ring-red-800/60",
            )}
        >
            {normalized}
        </span>
    );
}

export function ReferenceHeader({
    children,
    method,
    path,
    sdk,
    title,
    hideTitle = false,
}: {
    children?: ReactNode;
    method?: string;
    path?: string;
    sdk?: string;
    title: string;
    hideTitle?: boolean;
}) {
    const id = slugify(title);

    return (
        <section
            id={id}
            className={cn("not-prose mb-7 scroll-mt-24", hideTitle && "-mt-12 [&>aside+*]:-mt-12")}
            {...(hideTitle && { "data-hide-title": true })}
        >
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
                {method ? <MethodBadge method={method} /> : null}
                {hideTitle ? null : (
                    <h2 className="m-0 font-bold text-2xl text-fd-foreground leading-snug tracking-tight">
                        {title}
                    </h2>
                )}
            </div>

            {(path ?? sdk) ? (
                <div className="mb-4 flex flex-wrap gap-2">
                    {path ? (
                        <code className="inline-flex items-center rounded-md border border-fd-border bg-fd-muted/60 px-3 py-1.75 font-mono text-[12.5px] text-fd-muted-foreground leading-none">
                            {path}
                        </code>
                    ) : null}
                    {sdk ? (
                        <code className="inline-flex items-center rounded-md border border-fd-border bg-fd-muted/60 px-3 py-1.75 font-mono text-[12.5px] text-fd-muted-foreground leading-none">
                            {sdk}
                        </code>
                    ) : null}
                </div>
            ) : null}

            {children ? (
                <div className="m-0 max-w-150 text-[15px] text-fd-muted-foreground leading-[1.75]">
                    {children}
                </div>
            ) : null}
        </section>
    );
}

export function ReferenceGrid({ children }: { children: ReactNode }) {
    const examples = collectReferenceExamples(children);
    const railExamples = examples.map((example) => (
        <ExampleResponse key={example.key} value={example.value} />
    ));
    const displayChildren = railExamples.length
        ? withRailExamples(children, railExamples)
        : children;

    return (
        <div className="not-prose mx-auto my-12 grid w-full gap-8 *:min-w-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start xl:gap-12 xl:[&:has(section[data-hide-title=true])>aside]:-mt-12">
            {displayChildren}
        </div>
    );
}

export function Note({ children }: { children: ReactNode }) {
    return (
        <div className="mb-4 border-l-4 border-l-blue-700 px-4 pt-1.5 pb-3 pl-5">
            <p className="m-0! flex flex-row items-center font-semibold text-blue-700">
                <svg
                    data-component="Octicon"
                    className="mr-2 size-4"
                    viewBox="0 0 16 16"
                    version="1.1"
                    width="16"
                    height="16"
                    aria-hidden="true"
                    fill="currentColor"
                >
                    <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>
                </svg>
                Note
            </p>

            <div className="block! [&_p]:block! m-0! mt-1! space-y-1.5! text-fd-muted-foreground text-sm leading-normal [&_p]:m-0">
                {children}
            </div>
        </div>
    );
}

export function ImportantNote({ children }: { children: ReactNode }) {
    return (
        <div className="mb-4 border-l-4 border-l-purple-700 px-4 pt-1.5 pb-3 pl-5">
            <p className="m-0! flex flex-row items-center font-semibold text-purple-700">
                <svg
                    data-component="Octicon"
                    className="mr-2 size-4"
                    viewBox="0 0 16 16"
                    version="1.1"
                    width="16"
                    height="16"
                    aria-hidden="true"
                    fill="currentColor"
                >
                    <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
                </svg>
                Important
            </p>

            <p className="block! [&_p]:block! m-0! mt-1! space-y-4! text-fd-muted-foreground text-sm leading-normal [&_p]:m-0!">
                {children}
            </p>
        </div>
    );
}

export function CautionNote({ children }: { children: ReactNode }) {
    return (
        <div className="mb-4 border-l-4 border-l-[#d1242f] px-4 pt-1.5 pb-3 pl-5">
            <p className="m-0! flex flex-row items-center font-semibold text-[#d1242f]">
                <svg
                    data-component="Octicon"
                    className="mr-2 size-4"
                    viewBox="0 0 16 16"
                    version="1.1"
                    width="16"
                    height="16"
                    aria-hidden="true"
                    fill="currentColor"
                >
                    <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>
                </svg>
                Caution
            </p>

            <p className="block! [&_p]:block! m-0! mt-1! space-y-4! text-fd-muted-foreground text-sm leading-normal [&_p]:m-0!">
                {children}
            </p>
        </div>
    );
}

export function CodeRail({ children }: { children: ReactNode }) {
    return (
        <aside className="peer/code-rail fuelwatch-code-rail not-prose space-y-4 xl:sticky xl:top-20 xl:self-start [&_figure]:my-0 [&_pre]:max-h-[min(72vh,720px)] [&_pre]:text-[13px]">
            {children}
        </aside>
    );
}

function collectReferenceExamples(children: ReactNode): ReferenceExample[] {
    const examples: ReferenceExample[] = [];

    visitReactElements(children, (element) => {
        if (!isComponentElement<FieldTableProps>(element, FieldTable)) {
            return;
        }

        if (element.props.examplePlacement === "none") return;
        const title = element.props.title ?? "Parameters";
        const normalizedFields = normalizeReferenceFields(element.props.fields, title);
        const value = getReferenceExample(normalizedFields, title);

        if (value) {
            examples.push({
                key: `reference-example-${slugify(title)}-${hashString(JSON.stringify(value))}`,
                title,
                value,
            });
        }
    });

    return examples;
}

function withRailExamples(children: ReactNode, railExamples: ReactNode[]): ReactNode {
    if (!containsComponent(children, CodeRail)) {
        return children;
    }

    return mapReactElements(children, (element) => {
        if (isComponentElement<{ children?: ReactNode }>(element, CodeRail)) {
            return cloneElement(element, {
                children: (
                    <>
                        {element.props.children}
                        {railExamples}
                    </>
                ),
            });
        }

        if (isComponentElement<FieldTableProps>(element, FieldTable)) {
            return cloneElement(element, { examplePlacement: "none" });
        }

        return element;
    });
}

function containsComponent(children: ReactNode, component: unknown): boolean {
    let found = false;

    visitReactElements(children, (element) => {
        if (element.type === component) {
            found = true;
        }
    });

    return found;
}

function visitReactElements(node: ReactNode, visitor: (element: ReactElement) => void) {
    Children.forEach(node, (child) => {
        if (!isValidElement(child)) {
            return;
        }

        visitor(child);
        visitReactElements(getElementChildren(child), visitor);
    });
}

function mapReactElements(
    node: ReactNode,
    visitor: (element: ReactElement) => ReactElement,
): ReactNode {
    return Children.map(node, (child) => {
        if (!isValidElement(child)) {
            return child;
        }

        const children = getElementChildren(child);
        const mappedChildren = children ? mapReactElements(children, visitor) : children;
        const element =
            mappedChildren && mappedChildren !== children
                ? cloneElement(child as ReactElement<{ children?: ReactNode }>, {
                      children: mappedChildren,
                  })
                : child;

        return visitor(element);
    });
}

function isComponentElement<Props>(
    element: ReactElement,
    component: unknown,
): element is ReactElement<Props> {
    return element.type === component;
}

function getElementChildren(element: ReactElement): ReactNode | undefined {
    return (element.props as { children?: ReactNode }).children;
}

export function FieldTable({
    examplePlacement = "inline",
    fields,
    title = "Parameters",
    icon,
    iconName,
}: FieldTableProps & {
    icon?: LucideIcon;
    iconName?: string;
}) {
    const normalizedFields = normalizeReferenceFields(fields, title);
    const example = getReferenceExample(normalizedFields, title);

    const iconMap = {
        forward: ForwardIcon,
        reply: ReplyIcon,
        urlParams: BracesIcon,
        queryParams: Link2Icon,
        bodyParams: FileBracesCornerIcon,
    };

    const _Icon = icon || iconMap[iconName as keyof typeof iconMap] || undefined;

    return (
        <section className="not-prose my-8">
            {title ? (
                <h3 className="mb-3 flex flex-row items-center font-bold text-lg">
                    {/* {Icon ? (
                        <Icon className="mr-2 h-auto w-5 opacity-50" />
                    ) : null} */}
                    {title}
                </h3>
            ) : null}

            <div className="divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border">
                <FieldRows
                    fields={normalizedFields}
                    tableTitle={title}
                    className={title === "Response body fields" ? "bg-fd-muted" : undefined}
                />
            </div>

            {example && examplePlacement === "inline" ? (
                <div className="mt-4">
                    <ExampleResponse value={example} />
                </div>
            ) : null}
        </section>
    );
}

function FieldRows({
    collapseLargeFieldSets = true,
    depth = 0,
    expandedTypes = new Set<string>(),
    fields,
    tableTitle,
    className,
}: {
    collapseLargeFieldSets?: boolean;
    depth?: number;
    expandedTypes?: ReadonlySet<string>;
    fields: ReferenceField[];
    tableTitle: string;
    className?: string;
}) {
    const shouldCollapseFieldSet =
        collapseLargeFieldSets && depth > 0 && fields.length > maxVisibleChildFields;
    const visibleFields = shouldCollapseFieldSet ? fields.slice(0, maxVisibleChildFields) : fields;
    const hiddenFields = shouldCollapseFieldSet ? fields.slice(maxVisibleChildFields) : [];

    return (
        <>
            {visibleFields.map((field, index) => {
                const childShape = findReferenceShape(field.type);
                const enumValues = getFieldEnumValues(field);
                const childFields =
                    depth >= maxFieldExpansionDepth
                        ? undefined
                        : getChildFields(field, expandedTypes, childShape);
                const nextExpandedTypes = childShape
                    ? new Set([...expandedTypes, childShape.typeName])
                    : expandedTypes;
                const shouldAutoExpandChildFields =
                    depth === 0 &&
                    index === 0 &&
                    field.name === "params" &&
                    tableTitle.toLowerCase().includes("input");

                return (
                    <div
                        key={`${depth}-${field.name}`}
                        className={cn(
                            "grid gap-x-8 gap-y-1 px-4 py-4",
                            depth > 0 && "bg-fd-muted/15 px-3 py-3",
                            className,
                        )}
                    >
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <CopyTextInline text={field.name} className="flex">
                                    <code className="p-0! font-mono font-semibold text-[13.5px] text-fd-foreground leading-none">
                                        {field.name}
                                    </code>
                                </CopyTextInline>

                                <div className="break-all font-bold text-[11.5px] text-fd-muted-foreground/80 leading-none leading-relaxed">
                                    <TypeText type={field.type} />
                                </div>

                                {field.required ? (
                                    <span className="rounded border border-red-200/80 bg-red-50 px-1.5 py-0.75 font-semibold text-[10px] text-red-600 uppercase leading-none tracking-wide dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
                                        required
                                    </span>
                                ) : (
                                    <span className="rounded border border-fd-border px-1.5 py-0.75 font-semibold text-[10px] text-fd-muted-foreground uppercase leading-none tracking-wide">
                                        optional
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="text-[14px] text-fd-muted-foreground leading-relaxed">
                            <div>
                                <ReferenceDescription>{field.description}</ReferenceDescription>
                            </div>

                            {field.defaultValue ? (
                                <div className="mt-0.5 text-[13px]">
                                    <span className="text-fd-muted-foreground/70">Default:</span>{" "}
                                    <code className="rounded bg-fd-muted px-1.5 py-0.75 font-mono text-[12px]">
                                        {field.defaultValue}
                                    </code>
                                </div>
                            ) : null}

                            {enumValues.length ? <EnumValueList values={enumValues} /> : null}

                            {childFields?.length ? (
                                <details
                                    className="mt-3 overflow-hidden rounded-xl border border-fd-border bg-fd-background/80"
                                    open={shouldAutoExpandChildFields}
                                >
                                    <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-[12px] text-fd-muted-foreground transition-colors hover:text-fd-foreground">
                                        {getChildSummaryLabel(tableTitle)}
                                    </summary>

                                    <div className="divide-y divide-fd-border border-fd-border border-t bg-white dark:bg-black/30">
                                        <FieldRows
                                            depth={depth + 1}
                                            expandedTypes={nextExpandedTypes}
                                            fields={childFields}
                                            tableTitle={tableTitle}
                                        />
                                    </div>
                                </details>
                            ) : null}
                        </div>
                    </div>
                );
            })}

            {hiddenFields.length ? (
                <details
                    key={`${depth}-show-more-fields`}
                    className={cn(
                        "bg-fd-muted/15 [&>summary>#summary-text-show]:hidden [&[open]>summary>#summary-text-hide]:hidden [&[open]>summary>#summary-text-hide]:hidden [&[open]>summary>#summary-text-show]:flex",
                        className,
                    )}
                >
                    <summary className="flex cursor-pointer list-none flex-row items-center justify-center gap-1 border-fd-border bg-blue-300/20 px-3 py-1.5 font-semibold text-[12px] text-blue-600 transition-colors hover:bg-blue-300/30 hover:text-blue-800 dark:bg-blue-950/20 dark:hover:bg-blue-900/20 [&::-webkit-details-marker]:hidden">
                        <span className="sr-only">Show/hide {hiddenFields.length} more</span>
                        <span
                            id="summary-text-hide"
                            className="flex flex-row items-center justify-center gap-1"
                            aria-hidden={true}
                        >
                            <PlusIcon className="size-3.5 opacity-50" strokeWidth={2.5} /> Show{" "}
                            {hiddenFields.length} more
                        </span>
                        <span
                            id="summary-text-show"
                            className="flex-row items-center justify-center gap-1"
                            aria-hidden={true}
                        >
                            <MinusIcon className="size-3.5 opacity-50" strokeWidth={2.5} /> Hide
                            additional fields
                        </span>
                    </summary>
                    <div className="divide-y divide-fd-border border-fd-border border-t">
                        <FieldRows
                            collapseLargeFieldSets={false}
                            depth={depth}
                            expandedTypes={expandedTypes}
                            fields={hiddenFields}
                            tableTitle={tableTitle}
                            className={className}
                        />
                    </div>
                </details>
            ) : null}
        </>
    );
}

/** Render internal Markdown links without evaluating HTML or arbitrary link protocols. */
function ReferenceDescription({ children }: { children: ReactNode }) {
    if (typeof children !== "string") return children;
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const match of children.matchAll(
        /\[([^\]\n]+)\]\((\/docs(?:\/[a-z0-9/_-]+)?(?:#[a-z0-9_-]+)?)\)/gi,
    )) {
        parts.push(children.slice(offset, match.index));
        parts.push(
            <a key={match.index} href={match[2]}>
                {match[1]}
            </a>,
        );
        offset = match.index + match[0].length;
    }
    parts.push(children.slice(offset));
    return parts;
}

function EnumValueList({ values }: { values: readonly ReferenceEnumValue[] }) {
    return (
        <div className="mt-3 overflow-hidden rounded-lg border border-fd-border bg-fd-background">
            <div className="border-fd-border border-b px-3 py-2 font-semibold text-[12px] text-fd-foreground">
                Possible enum values
            </div>
            <div className="divide-y divide-fd-border">
                {values.map((item) => (
                    <div className="px-3 py-2.5" key={item.value}>
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                            <code className="shrink-0 rounded-md border border-fd-border bg-fd-muted/60 px-1.5 py-0.75 font-mono text-[11.5px] text-fd-foreground">
                                {item.value}
                            </code>
                            {item.label ? (
                                item.href ? (
                                    <a
                                        href={item.href}
                                        className="font-normal! text-[13px] text-fd-muted-foreground! underline-offset-4 hover:text-fd-foreground! hover:underline"
                                    >
                                        {item.label}
                                    </a>
                                ) : (
                                    <span className="text-[13px] text-fd-muted-foreground">
                                        {item.label}
                                    </span>
                                )
                            ) : null}
                        </div>
                        {item.description ? (
                            <p className="mt-2 mb-0 text-[13px] text-fd-muted-foreground leading-relaxed">
                                {item.description}
                            </p>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}

function TypeText({ type }: { type: string }) {
    let offset = 0;

    return tokenizeReferenceType(type).map((token) => {
        const key = `${offset}:${token.text}`;
        offset += token.text.length;

        return token.href ? (
            <a
                className="text-fd-foreground underline decoration-fd-muted-foreground/35 underline-offset-4 transition-colors hover:text-fd-primary hover:decoration-fd-primary/70"
                href={token.href}
                key={key}
            >
                {token.text}
            </a>
        ) : (
            <span key={key}>{token.text}</span>
        );
    });
}

function getChildFields(
    field: ReferenceField,
    expandedTypes: ReadonlySet<string>,
    shape = findReferenceShape(field.type),
): ReferenceField[] | undefined {
    if (field.children?.length && !isReferencePlaceholderList(field.children)) {
        return field.children;
    }

    if (!shape || expandedTypes.has(shape.typeName)) {
        return undefined;
    }

    return shapeFieldsToReferenceFields(shape.fields);
}

function isReferencePlaceholderList(fields: ReferenceField[]) {
    return fields.length === 1 && fields[0]?.name === "__reference";
}

function shapeFieldsToReferenceFields(
    fields: ReferenceShapeField[] | undefined,
): ReferenceField[] | undefined {
    if (!fields) {
        return undefined;
    }

    return fields.map((field) => ({
        ...field,
        children: shapeFieldsToReferenceFields(field.children),
    }));
}

function getChildSummaryLabel(tableTitle: string) {
    const normalized = tableTitle.toLowerCase();

    if (
        normalized.includes("input") ||
        normalized.includes("parameter") ||
        normalized.includes("header") ||
        normalized.includes("body") ||
        normalized.includes("query")
    ) {
        return "Show child parameters";
    }

    return "Show child fields";
}

function getReferenceExample(
    fields: ReferenceField[],
    title: string,
): Record<string, unknown> | undefined {
    if (!shouldShowReferenceExample(title)) {
        return undefined;
    }

    return buildReferenceExample(referenceFieldsToShapeFields(fields));
}

function normalizeReferenceFields(fields: ReferenceField[], title: string): ReferenceField[] {
    return (
        shapeFieldsToReferenceFields(
            groupDottedReferenceFields(
                referenceFieldsToShapeFields(fields),
                shouldShowReferenceExample(title)
                    ? "Object field. Expand to see child fields."
                    : "Object parameter. Expand to see child parameters.",
            ),
        ) ?? fields
    );
}

function shouldShowReferenceExample(title: string): boolean {
    const normalized = title.toLowerCase();
    return normalized.includes("returns") || normalized.includes("response");
}

function referenceFieldsToShapeFields(fields: ReferenceField[]): ReferenceShapeField[] {
    return fields.map((field) => ({
        ...field,
        description: typeof field.description === "string" ? field.description : "",
        children: field.children ? referenceFieldsToShapeFields(field.children) : undefined,
    }));
}

function ExampleResponse({ value }: { value: Record<string, unknown> }) {
    const json = JSON.stringify(value, null, 2);
    const tokens = tokenizeJsonForHighlight(json);
    let tokenOffset = 0;

    return (
        <figure className="shiki not-prose relative my-4 overflow-hidden rounded-xl border border-gray-200! bg-white! text-sm shadow-sm dark:border-gray-900! dark:bg-black!">
            <div className="flex h-9.5 items-center gap-2 border-fd-border border-b bg-inherit! px-4 py-2 font-semibold! text-[#737373]! text-sm! uppercase tracking-normal! dark:text-fd-muted-foreground">
                <div className="[&_svg]:size-3.5">
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path
                            d="M 6,1 C 4.354992,1 3,2.354992 3,4 v 16 c 0,1.645008 1.354992,3 3,3 h 12 c 1.645008,0 3,-1.354992 3,-3 V 8 7 A 1.0001,1.0001 0 0 0 20.707031,6.2929687 l -5,-5 A 1.0001,1.0001 0 0 0 15,1 h -1 z m 0,2 h 7 v 3 c 0,1.645008 1.354992,3 3,3 h 3 v 11 c 0,0.564129 -0.435871,1 -1,1 H 6 C 5.4358712,21 5,20.564129 5,20 V 4 C 5,3.4358712 5.4358712,3 6,3 Z M 15,3.4140625 18.585937,7 H 16 C 15.435871,7 15,6.5641288 15,6 Z"
                            fill="currentColor"
                        ></path>
                    </svg>
                </div>
                <figcaption className="flex-1 truncate">Example response</figcaption>
            </div>

            <pre className="m-0 p-0">
                <CodeBlock className="shiki shiki-themes github-light github-dark m-0 overflow-x-auto rounded-none! bg-transparent! bg-white! px-6 font-mono text-[13px] text-fd-foreground leading-relaxed dark:bg-black! *:[[role=region]]:bg-white! dark:*:[[role=region]]:bg-black!">
                    {tokens.map((token) => {
                        const key = `${tokenOffset}:${token.text}`;
                        tokenOffset += token.text.length;

                        return (
                            <span className={jsonTokenClassName[token.kind]} key={key}>
                                {token.text}
                            </span>
                        );
                    })}
                </CodeBlock>
            </pre>
        </figure>
    );
}

export function TypeShape({ typeName }: { typeName: string }) {
    const shape = getReferenceShape(typeName);

    if (!shape) {
        return null;
    }

    return (
        <section id={slugify(typeName)} className="not-prose my-10 scroll-mt-24">
            <h2 className="mb-2 font-bold text-2xl text-fd-foreground leading-snug tracking-tight">
                {typeName}
            </h2>
            <p className="m-0 max-w-170 text-[15px] text-fd-muted-foreground leading-[1.75]">
                <ReferenceDescription>{shape.description}</ReferenceDescription>
            </p>
            <FieldTable title="Fields" fields={shapeFieldsToReferenceFields(shape.fields) ?? []} />
        </section>
    );
}

/** Preferred headers for this public read-only API; no credentials are required. */
export function RequiredHeaders() {
    return (
        <FieldTable
            title="Request headers"
            fields={[
                {
                    name: "Accept",
                    type: "application/vnd.api+json",
                    description: "Recommended. Omission or a compatible wildcard is also accepted.",
                },
                {
                    name: "If-None-Match",
                    type: "string",
                    description:
                        "Optional ETag from a previously stored response to the same selection.",
                },
            ]}
        />
    );
}

/** Render canonical illustrative examples validated by the OpenAPI test suite. */
export function ApiExample({ name }: { name: keyof typeof specification.components.examples }) {
    return <ExampleResponse value={specification.components.examples[name].value} />;
}

export function MethodTable({ rows, title = "Methods" }: { rows: MethodRow[]; title?: string }) {
    return (
        <section className="not-prose my-8">
            {title ? (
                <div className="mb-3">
                    <span className="font-semibold text-[11px] text-fd-muted-foreground uppercase tracking-widest">
                        {title}
                    </span>
                </div>
            ) : null}
            <div className="divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border">
                {rows.map((row) => (
                    <div key={row.name} className="px-4 py-3.5">
                        <div className="flex flex-wrap items-start gap-x-5 gap-y-1.5">
                            <code className="shrink-0 font-mono font-semibold text-[13.5px] text-fd-foreground">
                                {row.name}
                            </code>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-fd-muted-foreground/80">
                                <span className="truncate">{row.parameters}</span>
                                <span className="select-none text-fd-muted-foreground/40">→</span>
                                <span className="truncate">{row.returns}</span>
                            </div>
                        </div>
                        {row.description ? (
                            <p className="mt-1.5 text-[13px] text-fd-muted-foreground leading-relaxed">
                                {row.description}
                            </p>
                        ) : null}
                    </div>
                ))}
            </div>
        </section>
    );
}

export function ServiceTable({ rows }: { rows: ServiceRow[] }) {
    return (
        <section className="not-prose my-8">
            <div className="mb-3">
                <span className="font-semibold text-[11px] text-fd-muted-foreground uppercase tracking-widest">
                    Service Surface
                </span>
            </div>
            <div className="divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border">
                {rows.map((row) => (
                    <div
                        key={row.service}
                        className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 py-4"
                    >
                        <code className="min-w-40 shrink-0 font-mono font-semibold text-[13.5px] text-fd-foreground">
                            {row.service}
                        </code>
                        <div className="flex flex-wrap gap-1.5">
                            {row.methods.split(",").map((m) => (
                                <code
                                    key={`${row.service}-${m.trim()}`}
                                    className="rounded-md border border-fd-border bg-fd-muted/60 px-2 py-1 font-mono text-[11.5px] text-fd-muted-foreground"
                                >
                                    {m.trim()}
                                </code>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

export function getMDXComponents(components?: MDXComponents) {
    return {
        ...defaultMdxComponents,
        ApiExample,
        CodeRail,
        FieldTable,
        MethodTable,
        ReferenceGrid,
        ReferenceHeader,
        RequiredHeaders,
        ServiceTable,
        TypeShape,
        Note,
        ImportantNote,
        CautionNote,
        pre: ({ ref: _ref, ...props }: ComponentProps<"pre">) => (
            <CodeBlock {...props}>
                <Pre>{props.children}</Pre>
            </CodeBlock>
        ),
        ...components,
    } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
    type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
