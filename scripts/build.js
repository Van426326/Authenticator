#!/usr/bin/env node

const { spawnSync } = require("child_process");
const {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const platform = process.argv[2];
const supportedPlatforms = new Set([
  "chrome",
  "firefox",
  "edge",
  "prod",
  "test",
]);

process.chdir(rootDir);

if (!supportedPlatforms.has(platform)) {
  console.error(
    "Invalid platform type. Supported platforms are 'chrome', 'firefox', 'edge', 'test', and 'prod'"
  );
  process.exit(1);
}

function runNode(relativeScript, args, options = {}) {
  const script = path.join(rootDir, relativeScript);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status || 1);
  }

  return result.status === 0;
}

function getGitRemote() {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout.trim() : "";
}

function copyInto(source, destinationDirectory) {
  const destination = path.join(destinationDirectory, path.basename(source));
  cpSync(source, destination, { recursive: true });
}

function postCompile(target) {
  const targetDirectory = path.join(rootDir, target);
  mkdirSync(targetDirectory);

  for (const item of ["dist", "css", "images", "_locales", "LICENSE", "view"]) {
    copyInto(path.join(rootDir, item), targetDirectory);
  }

  const manifestName =
    platform === "test"
      ? `manifest-${target}-testing.json`
      : `manifest-${target}.json`;
  copyFileSync(
    path.join(rootDir, "manifests", manifestName),
    path.join(targetDirectory, "manifest.json")
  );

  if (target === "chrome" || target === "edge") {
    copyFileSync(
      path.join(rootDir, "manifests", "schema-chrome.json"),
      path.join(targetDirectory, "schema.json")
    );
  }

  copyFileSync(
    path.join(rootDir, "manifests", "manifest-pwa.json"),
    path.join(targetDirectory, "manifest-pwa.json")
  );
}

try {
  const remote = getGitRemote();
  const credentials = readFileSync(
    path.join(rootDir, "src", "models", "credentials.ts"),
    "utf8"
  ).replace(/[\r\n]/g, "");
  const credentialPattern = /^.*".+".*".+".*".+".*".+".*".+".*$/;

  console.log("Removing old build files...");
  for (const item of [
    "build",
    "dist",
    "firefox",
    "chrome",
    "edge",
    "release",
    "test",
  ]) {
    rmSync(path.join(rootDir, item), { force: true, recursive: true });
  }

  console.log("Checking style...");
  const styleIsValid = runNode(
    "node_modules/prettier/bin-prettier.js",
    ["--check", "src", "sass/*.scss"],
    { allowFailure: true }
  );
  if (!styleIsValid) {
    runNode("node_modules/prettier/bin-prettier.js", [
      "--write",
      "src",
      "sass/*.scss",
    ]);
  }

  runNode("node_modules/eslint/bin/eslint.js", [".", "--ext", ".js,.ts"]);

  if (!credentialPattern.test(credentials)) {
    const label = platform === "prod" ? "Error" : "Warning";
    console.warn(
      `\x1b[7m\x1b[33m${label}: Missing info in credentials.ts\x1b[0m`
    );
    if (platform === "prod") {
      process.exit(1);
    }
  }

  const isUpstream =
    remote.includes(
      "https://github.com/Authenticator-Extension/Authenticator.git"
    ) ||
    remote.includes("git@github.com:Authenticator-Extension/Authenticator.git");
  if (!isUpstream && !process.env.CI) {
    console.log("\n\x1b[7m\x1b[33mNotice\x1b[0m\n");
    console.log(
      "This fork requires its own third-party API credentials before redistribution. Configure ./src/models/credentials.ts and the relevant manifest values.\n"
    );
  }

  console.log("Compiling...");
  if (platform === "prod") {
    runNode("node_modules/webpack-cli/bin/cli.js", [
      "--config",
      "webpack.prod.js",
    ]);
  } else if (platform === "test") {
    runNode("node_modules/webpack-cli/bin/cli.js", [
      "--config",
      "webpack.dev.js",
    ]);
    runNode("node_modules/typescript/bin/tsc", [
      "--target",
      "ES2015",
      "--esModuleInterop",
      "--moduleResolution",
      "nodenext",
      "--module",
      "commonjs",
      "scripts/test-runner.ts",
    ]);
  } else {
    runNode("node_modules/webpack-cli/bin/cli.js", []);
  }

  runNode("node_modules/sass/sass.js", ["sass:css"]);
  copyFileSync(
    path.join(rootDir, "sass", "DroidSansMono.woff2"),
    path.join(rootDir, "css", "DroidSansMono.woff2")
  );
  copyFileSync(
    path.join(rootDir, "sass", "mocha.css"),
    path.join(rootDir, "css", "mocha.css")
  );

  if (platform === "prod") {
    console.log("Generating licenses file...");
    runNode("node_modules/npm-license-generator/build/npm-license-generator", [
      "--out-path",
      "./view/licenses.html",
      "--template",
      "./scripts/licenses-template.html",
      "--error-missing=true",
    ]);
  }

  if (platform === "prod") {
    postCompile("chrome");
    postCompile("firefox");
    postCompile("edge");
    mkdirSync(path.join(rootDir, "release"));
    for (const target of ["chrome", "firefox", "edge"]) {
      renameSync(
        path.join(rootDir, target),
        path.join(rootDir, "release", target)
      );
    }
  } else if (platform === "test") {
    postCompile("chrome");
    postCompile("firefox");
    mkdirSync(path.join(rootDir, "test"));
    for (const target of ["chrome", "firefox"]) {
      renameSync(
        path.join(rootDir, target),
        path.join(rootDir, "test", target)
      );
    }
  } else {
    postCompile(platform);
  }

  console.log("\x1b[32mDone!\x1b[0m");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
