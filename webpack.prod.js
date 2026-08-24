const { merge } = require("webpack-merge");
const common = require("./webpack.config.js");

module.exports = merge(common, {
  mode: "production",
  devtool: false,
  // Keep production bundles under an explicit extension budget. The default
  // 244 KiB web-page threshold is not representative for self-contained
  // extension entrypoints and otherwise emits non-actionable warnings.
  performance: {
    hints: "warning",
    maxAssetSize: 650 * 1024,
    maxEntrypointSize: 650 * 1024,
  },
});
