/** @type {import('prettier').Config & import('prettier-plugin-tailwindcss').PluginOptions} */
module.exports = {
    tabWidth: 4,
    useTabs: false,
    semi: true,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    plugins: [
        "prettier-plugin-tailwindcss",
        "prettier-plugin-tailwindcss-canonical-classes",
    ],
    trailingComma: "all",
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: "always",
    endOfLine: "lf",
};
