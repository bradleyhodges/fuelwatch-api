import specification from "../../public/openapi.json";

export type ReferenceEnumValue = { description?: string; value: string };
export type ReferenceShapeField = {
    allowedValues?: string[];
    defaultValue?: string;
    description: string;
    enumValues?: readonly ReferenceEnumValue[];
    name: string;
    required?: boolean;
    type: string;
    children?: ReferenceShapeField[];
};
export type ReferenceShape = {
    description: string;
    fields: ReferenceShapeField[];
    typeName: string;
};
type Schema = {
    $ref?: string;
    const?: unknown;
    type?: string | string[];
    description?: string;
    format?: string;
    enum?: unknown[];
    default?: unknown;
    properties?: Record<string, Schema>;
    items?: Schema;
    required?: string[];
    oneOf?: Schema[];
};
const schemas: Record<string, Schema> = specification.components.schemas;
export const referenceTypeNames = Object.keys(schemas).sort();
export type ReferenceTypeToken = { href?: string; text: string };

/** Link HTTP schema names to this site's API schema reference, never an SDK page. */
export function getReferenceTypeHref(name: string): string | undefined {
    return Object.hasOwn(schemas, name)
        ? `/docs/api-reference/response-schema#${name.toLowerCase()}`
        : undefined;
}
export function getReferenceTypeNames(type: string): string[] {
    return [
        ...new Set(
            (type.match(/\b[A-Z][A-Za-z0-9]*/g) ?? []).filter((name) => getReferenceTypeHref(name)),
        ),
    ];
}
export function tokenizeReferenceType(type: string): ReferenceTypeToken[] {
    return type
        .split(/(\b[A-Z][A-Za-z0-9]*\b)/g)
        .filter(Boolean)
        .map((text) => ({
            text,
            ...(getReferenceTypeHref(text) ? { href: getReferenceTypeHref(text) } : {}),
        }));
}
/** Read enum values from the same OpenAPI schema used to validate examples. */
export function getReferenceEnumValues(type: string): readonly ReferenceEnumValue[] | undefined {
    for (const name of getReferenceTypeNames(type)) {
        const values = schemas[name]?.enum;
        if (values) return values.map((value) => ({ value: String(value) }));
    }
    return undefined;
}
function typeText(schema: Schema): string {
    if (schema.$ref) return schema.$ref.split("/").at(-1) ?? "unknown";
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.oneOf) return schema.oneOf.map(typeText).join(" | ");
    if (schema.type === "array") return `${schema.items ? typeText(schema.items) : "unknown"}[]`;
    if (Array.isArray(schema.type)) return schema.type.join(" | ");
    return schema.type ?? "unknown";
}
function fieldsFor(schema: Schema): ReferenceShapeField[] {
    return Object.entries(schema.properties ?? {}).map(([name, field]) => ({
        name,
        type: typeText(field),
        description:
            field.description ??
            (field.$ref ? schemas[field.$ref.split("/").at(-1) ?? ""]?.description : undefined) ??
            "See the linked schema for this field.",
        required: schema.required?.includes(name) ?? false,
        ...(field.default !== undefined ? { defaultValue: String(field.default) } : {}),
        ...(field.enum
            ? { enumValues: field.enum.map((value) => ({ value: String(value) })) }
            : {}),
        ...(field.properties ? { children: fieldsFor(field) } : {}),
    }));
}
export function getReferenceShape(typeName: string): ReferenceShape | undefined {
    const schema = schemas[typeName];
    if (!schema) return undefined;
    return {
        typeName,
        description: schema.description ?? `HTTP ${typeName} schema.`,
        fields: schema.properties
            ? fieldsFor(schema)
            : [
                  {
                      name: "value",
                      type: typeText(schema),
                      required: true,
                      description: schema.description ?? "Accepted value.",
                      enumValues: schema.enum?.map((value) => ({ value: String(value) })),
                  },
              ],
    };
}
export function findReferenceShape(type: string): ReferenceShape | undefined {
    const name = getReferenceTypeNames(type)[0];
    return name ? getReferenceShape(name) : undefined;
}

/** Keep dotted field tables expandable without modifying the caller's field definitions. */
export function groupDottedReferenceFields(
    fields: readonly ReferenceShapeField[],
    parentDescription = "Object field. Expand to see child fields.",
): ReferenceShapeField[] {
    const result: ReferenceShapeField[] = [];
    const parents = new Map<string, ReferenceShapeField>();
    const existing = new Set(fields.map((field) => field.name));
    for (const field of fields) {
        const match = /^([A-Za-z][A-Za-z0-9_]*)\.(.+)$/.exec(field.name);
        if (!match || existing.has(match[1])) {
            result.push({
                ...field,
                ...(field.children
                    ? { children: groupDottedReferenceFields(field.children, parentDescription) }
                    : {}),
            });
            continue;
        }
        let parent = parents.get(match[1]);
        if (!parent) {
            parent = {
                name: match[1],
                type: "object",
                description: parentDescription,
                children: [],
            };
            parents.set(match[1], parent);
            result.push(parent);
        }
        parent.children?.push({ ...field, name: match[2] });
    }
    for (const parent of parents.values()) {
        parent.children = groupDottedReferenceFields(parent.children ?? [], parentDescription);
    }
    return result;
}

/**
 * Build only examples with an explicit specification source.
 * Prose tables must not fabricate response values from type names; use ApiExample
 * for the complete schema-validated document and optional inline field examples here.
 */
export function buildReferenceExample(
    fields: readonly ReferenceShapeField[],
): Record<string, unknown> | undefined {
    const compact = specification.components.examples.Compact.value;
    const examples: Record<string, unknown> = {
        PriceDocument: compact,
        ServiceStation: compact.data[0],
        StationAttributes: compact.data[0].attributes,
        Metadata: compact.meta,
        Price: compact.data[0].attributes.price,
        Address: compact.data[0].attributes.address,
        Brand: specification.components.examples.Expanded.value.data[0].attributes.brand,
    };
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        const name = getReferenceTypeNames(field.type)[0];
        if (!name || !Object.hasOwn(examples, name)) return undefined;
        result[field.name] = field.type.includes("[]") ? [examples[name]] : examples[name];
    }
    return Object.keys(result).length ? result : undefined;
}
