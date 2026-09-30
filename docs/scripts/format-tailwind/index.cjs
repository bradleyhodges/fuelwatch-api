const { execSync } = require("node:child_process");
const path = require("node:path");

const prettierConfigPath = path.join(__dirname, "prettier.config.cjs");
const biomeConfigPath = path.join(__dirname, "../../../biome.json");
const appPath = path.join(__dirname, "../../src/");

try {
    // Run the linter
    console.log("🧼 ", `Formatting all files using prettier...`);
    execSync(
        `npx prettier --config "${prettierConfigPath}" --cache --write "**/*.{js,jsx,ts,tsx,css}"`,
        {
            cwd: appPath,
            stdio: "inherit",
        },
    );
} catch (error) {
    console.error(
        "❌",
        `Error formatting all files using prettier:`,
        error.message,
    );
    process.exit(1);
}

console.log("🫧 ", `Successfully executed prettier for all files!`);
console.log("🧹 ", "Running biome format script...");

try {
    execSync(
        `pnpm biome check . --write --skip-parse-errors --config-path "${biomeConfigPath}"`,
        {
            cwd: appPath,
            stdio: "inherit",
        },
    );

    console.log("🧹 ", "Biome check completed successfully!");
} catch (error) {
    console.error(
        "🧹 ",
        "Biome check failed:",
        error.stderr?.toString() || error.message,
    );
    process.exit(1); // Exit gracefully or continue as needed
}

console.log(
    "🎉 ",
    "All done! All files were linted and formatted successfully.",
);
