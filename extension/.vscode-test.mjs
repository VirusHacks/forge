import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  ...(process.env.VSCODE_EXECUTABLE
    ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE } }
    : { version: "stable" }),
  launchArgs: ["--profile-temp"],
});

