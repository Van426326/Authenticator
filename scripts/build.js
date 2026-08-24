#!/usr/bin/env node

const { spawnSync } = require("child_process");
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
    "Invalid platform type. Supported platforms are 'chrome', 'firefox', 'edge', 'test', and 'prod'",
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

function copyInto(source, destinationDirectory) {
  const destination = path.join(destinationDirectory, path.basename(source));
  cpSync(source, destination, { recursive: true });
}

/**
 * Mirrors a completed build into a stable directory without deleting that
 * directory. Chrome associates unpacked-extension storage with the loaded
 * extension; removing its root during a rebuild can make Chrome treat it as
 * an uninstall and clear chrome.storage.local.
 */
function mirrorDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  const sourceNames = new Set(readdirSync(source));

  for (const name of readdirSync(destination)) {
    if (!sourceNames.has(name)) {
      rmSync(path.join(destination, name), { force: true, recursive: true });
    }
  }

  for (const name of sourceNames) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isDirectory()) {
      if (
        existsSync(destinationPath) &&
        !lstatSync(destinationPath).isDirectory()
      ) {
        rmSync(destinationPath, { force: true, recursive: true });
      }
      mirrorDirectory(sourcePath, destinationPath);
    } else {
      if (
        existsSync(destinationPath) &&
        lstatSync(destinationPath).isDirectory()
      ) {
        rmSync(destinationPath, { force: true, recursive: true });
      }
      copyFileSync(sourcePath, destinationPath);
    }
  }
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
    path.join(targetDirectory, "manifest.json"),
  );

  if (target === "chrome" || target === "edge") {
    copyFileSync(
      path.join(rootDir, "manifests", "schema-chrome.json"),
      path.join(targetDirectory, "schema.json"),
    );
  }

  copyFileSync(
    path.join(rootDir, "manifests", "manifest-pwa.json"),
    path.join(targetDirectory, "manifest-pwa.json"),
  );
}

try {
  console.log("Removing old build files...");
  for (const item of ["build", "dist", "firefox", "chrome", "edge", "test"]) {
    rmSync(path.join(rootDir, item), { force: true, recursive: true });
  }

  console.log("Checking style...");
  const styleIsValid = runNode(
    "node_modules/prettier/bin-prettier.js",
    ["--check", "src", "sass/*.scss"],
    { allowFailure: true },
  );
  if (!styleIsValid) {
    runNode("node_modules/prettier/bin-prettier.js", [
      "--write",
      "src",
      "sass/*.scss",
    ]);
  }

  runNode("node_modules/eslint/bin/eslint.js", [".", "--ext", ".js,.ts"]);

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
    path.join(rootDir, "css", "DroidSansMono.woff2"),
  );
  copyFileSync(
    path.join(rootDir, "sass", "mocha.css"),
    path.join(rootDir, "css", "mocha.css"),
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
    const releaseDirectory = path.join(rootDir, "release");
    mkdirSync(releaseDirectory, { recursive: true });
    for (const target of ["chrome", "firefox", "edge"]) {
      const completedBuild = path.join(rootDir, target);
      mirrorDirectory(completedBuild, path.join(releaseDirectory, target));
      rmSync(completedBuild, { force: true, recursive: true });
    }
  } else if (platform === "test") {
    postCompile("chrome");
    postCompile("firefox");
    mkdirSync(path.join(rootDir, "test"));
    for (const target of ["chrome", "firefox"]) {
      renameSync(
        path.join(rootDir, target),
        path.join(rootDir, "test", target),
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
