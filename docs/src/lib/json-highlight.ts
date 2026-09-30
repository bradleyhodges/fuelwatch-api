export type JsonHighlightToken = {
    kind: "boolean" | "key" | "null" | "number" | "plain" | "punctuation" | "string";
    text: string;
};

const jsonTokenPattern =
    /"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}[\]:,]/g;

export function tokenizeJsonForHighlight(json: string): JsonHighlightToken[] {
    const tokens: JsonHighlightToken[] = [];
    let lastIndex = 0;
    let match = jsonTokenPattern.exec(json);

    while (match) {
        const [text] = match;

        if (match.index > lastIndex) {
            tokens.push({
                kind: "plain",
                text: json.slice(lastIndex, match.index),
            });
        }

        tokens.push({
            kind: getJsonTokenKind(json, text, match.index),
            text,
        });

        lastIndex = match.index + text.length;
        match = jsonTokenPattern.exec(json);
    }

    if (lastIndex < json.length) {
        tokens.push({ kind: "plain", text: json.slice(lastIndex) });
    }

    return tokens;
}

function getJsonTokenKind(json: string, text: string, index: number): JsonHighlightToken["kind"] {
    if (/^[{}[\]:,]$/.test(text)) {
        return "punctuation";
    }

    if (text === "true" || text === "false") {
        return "boolean";
    }

    if (text === "null") {
        return "null";
    }

    if (text.startsWith('"')) {
        const afterToken = json.slice(index + text.length);
        return /^\s*:/.test(afterToken) ? "key" : "string";
    }

    return "number";
}
