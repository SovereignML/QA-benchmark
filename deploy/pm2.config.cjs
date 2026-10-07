// pm2 ecosystem file for running AutoSignUp next to atlasagents-app.
//
//   pm2 start deploy/pm2.config.cjs && pm2 save
//
// ONE process, fork mode: the scheduler and the record files assume a single
// writer. Never run this in cluster mode or with instances > 1.

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const envFile = path.join(root, ".env")
if (!fs.existsSync(envFile)) {
  console.error(`[autosignup] Refusing to start: ${envFile} is missing. Copy .env.example.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) {
  console.error("[autosignup] Refusing to start: run `npm run build` first.")
  process.exit(1)
}

// Next reads .env itself at runtime; only the listen address is needed here.
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]),
)
// 127.0.0.1 = SSH tunnel only. 172.17.0.1 = also reachable from Docker
// (Nginx Proxy Manager) but not from the internet.
const bind = env.AUTOSIGNUP_BIND || "127.0.0.1"
if (bind === "0.0.0.0" || bind === "::") {
  console.error("[autosignup] Refusing to listen on all interfaces. Use 127.0.0.1 or the Docker bridge IP (172.17.0.1).")
  process.exit(1)
}

module.exports = {
  apps: [
    {
      name: "autosignup",
      cwd: root,
      script: "node_modules/next/dist/bin/next",
      args: `start -H ${bind} -p 3003`,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 15000,
      env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
}
