import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node-only libraries; load them from node_modules at runtime instead of bundling.
  serverExternalPackages: ["pg", "exceljs", "bcryptjs"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
