// Runs tests via puppeteer. Do not compile using webpack.

import puppeteer from "puppeteer";
import path from "path";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import merge from "lodash/merge";

interface MochaTestResults {
  total?: number;
  tests?: StrippedTestResults[];
  completed?: boolean;
}

interface StrippedTestResults {
  title: string;
  duration: number;
  path: string[];
  err?: string;
  status: "failed" | "passed" | "pending";
}

declare global {
  interface Window {
    __mocha_test_results__: MochaTestResults;
  }
}
interface TestDisplay {
  [key: string]: TestDisplay | StrippedTestResults;
}

function isTestResult(
  value: TestDisplay | StrippedTestResults,
): value is StrippedTestResults {
  return "status" in value && typeof value.status === "string";
}

function resolveBrowserExecutable() {
  const executablePath =
    process.env.PUPPETEER_EXEC_PATH || puppeteer.executablePath();
  if (
    executablePath.includes("/Applications/Google Chrome.app/") &&
    !executablePath.includes("Google Chrome for Testing.app")
  ) {
    throw new Error(
      "Branded Chrome does not load unpacked extensions. Use Chrome for Testing or Chromium.",
    );
  }
  if (executablePath.includes(".app/Contents/MacOS/")) {
    const contents = path.resolve(path.dirname(executablePath), "..");
    if (
      !existsSync(path.join(contents, "Info.plist")) ||
      !existsSync(path.join(contents, "Frameworks"))
    ) {
      throw new Error(
        "Chrome for Testing is incomplete. Reinstall it with: npx puppeteer browsers install chrome",
      );
    }
  }
  return executablePath;
}

function getExtensionId(extensionDirectory: string) {
  let manifest: { key?: unknown };
  try {
    manifest = JSON.parse(
      readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"),
    );
  } catch {
    throw new Error("Could not read the built Chrome test manifest");
  }
  if (typeof manifest.key !== "string") {
    throw new Error("Chrome test manifest must contain a stable extension key");
  }
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode("a".charCodeAt(0) + parseInt(digit, 16)),
  );
}

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

async function runTests() {
  const extensionDirectory = path.resolve(__dirname, "../test/chrome");
  const extensionId = getExtensionId(extensionDirectory);
  const puppeteerArgs: string[] = [
    `--load-extension=${extensionDirectory}`,
    // for CI
    "--no-sandbox",
    "--lang=en-US,en",
  ];

  const browser = await puppeteer.launch({
    ignoreDefaultArgs: ["--disable-extensions"],
    args: puppeteerArgs,
    // chrome extensions don't work in headless
    headless: false,
    executablePath: resolveBrowserExecutable(),
  });
  const mochaPage = await browser.newPage();
  await mochaPage.goto(`chrome-extension://${extensionId}/view/test.html`);

  // by setting this env var, console logging works for both components and testing
  if (process.env.ENABLE_CONSOLE) {
    mochaPage.on("console", (consoleMessage) =>
      console.log(consoleMessage.text()),
    );
  }

  const results: {
    testResults: MochaTestResults;
  } = await mochaPage.evaluate(() => {
    return new Promise(
      (resolve: (value: { testResults: MochaTestResults }) => void) => {
        window.addEventListener("testsComplete", () => {
          resolve({
            testResults: window.__mocha_test_results__,
          });
        });

        if (window.__mocha_test_results__.completed) {
          resolve({
            testResults: window.__mocha_test_results__,
          });
        }
      },
    );
  });

  let failedTest = false;
  let display: TestDisplay = {};
  if (results?.testResults.tests) {
    for (const test of results.testResults.tests) {
      let tmp: TestDisplay = {};
      test.path.reduce((acc, current, index) => {
        return (acc[current] = test.path.length - 1 === index ? test : {});
      }, tmp);
      display = merge(display, tmp);
    }
  }

  const printDisplayTests = (currentDisplay: TestDisplay) => {
    for (const key in currentDisplay) {
      const item = currentDisplay[key];
      if (isTestResult(item)) {
        const test = item;
        switch (test.status) {
          case "passed":
            console.log(`${colors.green}✓${colors.reset} ${test.title}`);
            break;
          case "failed":
            console.log(`${colors.red}✗ ${test.title}${colors.reset}`);
            if (test.err) {
              console.log(test.err);
            }
            failedTest = true;
            break;
          case "pending":
            console.log(`- ${test.title}`);
            break;
        }
      } else {
        console.log(key);
        console.group();
        printDisplayTests(item);
      }
    }
    console.groupEnd();
  };
  printDisplayTests(display);
  process.exit(failedTest ? 1 : 0);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
