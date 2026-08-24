const path = require("path");
const { merge } = require("webpack-merge");
const dev = require("./webpack.dev.js");
const { exec } = require("child_process");

// After compiling, automatically run the tests for each watched build.
const runTestsAfterBuild = () => {
  return {
    apply: (compiler) => {
      compiler.hooks.afterEmit.tap("AfterEmitPlugin", () => {
        // Leave as Node otherwise the browser does not launch.
        exec("node scripts/test-runner.js", (_error, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
        });
      });
    },
  };
};

module.exports = merge(dev, {
  mode: "development",
  plugins: [runTestsAfterBuild()],
  watch: true,
  watchOptions: {
    ignored: /node_modules/,
  },
  output: {
    path: path.resolve(__dirname, "test/chrome/dist"),
    publicPath: "/test/chrome/dist/",
  },
});
