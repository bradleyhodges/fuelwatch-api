import type { StringifyOptions } from "fumadocs-core/mdx-plugins/remark-structure";
import specification from "../../public/openapi.json";
import { getExampleCaption, getExampleRequest } from "./api-examples";
import { getFieldEnumValues, getReferenceShape, type ReferenceShapeField } from "./reference-types";

type MdxNode = Extract<
    Parameters<NonNullable<StringifyOptions["stringify"]>>[0],
    { type: "mdxJsxFlowElement" | "mdxJsxTextElement" }
>;

/** Decode only static MDX literals. Never evaluate expressions while exporting documentation. */
function literal(node: unknown): unknown {
    if (!node || typeof node !== "object" || !("type" in node)) return undefined;
    if (node.type === "Literal" && "value" in node) return node.value;
    if (node.type === "ArrayExpression" && "elements" in node && Array.isArray(node.elements)) {
        return node.elements.map(literal);
    }
    if (
        node.type === "ObjectExpression" &&
        "properties" in node &&
        Array.isArray(node.properties)
    ) {
        const entries: [string, unknown][] = [];
        for (const property of node.properties) {
            if (
                !property ||
                typeof property !== "object" ||
                property.type !== "Property" ||
                property.computed ||
                property.method
            )
                return undefined;
            const key =
                property.key?.type === "Identifier" ? property.key.name : literal(property.key);
            if (typeof key !== "string") return undefined;
            entries.push([key, literal(property.value)]);
        }
        return Object.fromEntries(entries);
    }
    return undefined;
}

function attribute(node: MdxNode, name: string): unknown {
    const attr = node.attributes.find(
        (item) => item.type === "mdxJsxAttribute" && item.name === name,
    );
    if (attr?.type !== "mdxJsxAttribute") return undefined;
    if (typeof attr.value === "string") return attr.value;
    const statement = attr.value?.data?.estree?.body[0];
    return statement?.type === "ExpressionStatement" ? literal(statement.expression) : undefined;
}

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function fieldsMarkdown(fields: readonly ReferenceShapeField[], prefix = ""): string {
    return fields
        .map((field) => {
            const enumValues = getFieldEnumValues(field);
            const details = [
                field.description,
                field.defaultValue !== undefined ? `Default: ${field.defaultValue}.` : "",
                enumValues.length
                    ? `Allowed: ${enumValues
                          .map((item) => {
                              const { label, href } = item;
                              return label
                                  ? `${item.value} (${href ? `[${label}](${href})` : label})`
                                  : item.value;
                          })
                          .join(", ")}.`
                    : "",
            ]
                .filter(Boolean)
                .join(" ");
            const line = `| ${cell(prefix + field.name)} | ${cell(field.type)} | ${field.required ? "Yes" : "No"} | ${cell(details)} |`;
            return field.children
                ? `${line}\n${fieldsMarkdown(field.children, `${prefix}${field.name}.`)}`
                : line;
        })
        .join("\n");
}

function table(fields: readonly ReferenceShapeField[]): string {
    return (
        "| Field | Type | Required | Description |\n| --- | --- | --- | --- |\n" +
        fieldsMarkdown(fields)
    );
}

/** Keep custom reference components readable in Markdown downloads and the search index. */
export function stringifyReference(
    node: Parameters<NonNullable<StringifyOptions["stringify"]>>[0],
): string | undefined {
    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return undefined;
    if (node.name === "TypeShape") {
        const name = attribute(node, "typeName");
        const shape = typeof name === "string" ? getReferenceShape(name) : undefined;
        if (!shape) throw new Error(`Unknown schema in Markdown export: ${String(name)}`);
        return `## ${shape.typeName}\n\n${shape.description}\n\n${table(shape.fields)}`;
    }
    if (node.name === "ApiExample") {
        const name = attribute(node, "name");
        const examples = specification.components.examples;
        if (typeof name !== "string" || !Object.hasOwn(examples, name))
            throw new Error(`Unknown API example: ${String(name)}`);
        const exampleName = name as keyof typeof examples;
        const example = examples[exampleName];
        return `**${example.summary}**\n\n${getExampleCaption(exampleName)}\n\n\`\`\`bash\n${getExampleRequest(exampleName)}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(example.value, null, 2)}\n\`\`\``;
    }
    if (node.name === "FieldTable") {
        const fields = attribute(node, "fields");
        if (
            !Array.isArray(fields) ||
            !fields.every(
                (field) =>
                    field &&
                    typeof field.name === "string" &&
                    typeof field.type === "string" &&
                    typeof field.description === "string",
            )
        ) {
            throw new Error("FieldTable Markdown export requires static field definitions.");
        }
        const title = attribute(node, "title");
        return `${typeof title === "string" ? `### ${title}\n\n` : ""}${table(fields)}`;
    }
    if (node.name === "RequiredHeaders") {
        return table([
            {
                name: "Accept",
                type: "string",
                description:
                    "Recommended: application/vnd.api+json. No authentication is required.",
            },
            {
                name: "If-None-Match",
                type: "string",
                description: "Optional previous ETag for conditional requests.",
            },
        ]);
    }
    return undefined;
}
