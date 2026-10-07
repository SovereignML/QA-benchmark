// pm2 ecosystem file for running AutoSignUp next to atlasagents-app.
//
//   pm2 start deploy/pm2.config.cjs && pm2 save
//
// ONE process, fork mode: the scheduler and the record files assume a single
// writer. Never run this in cluster mode or with instances > 1.

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
if (!fs.existsSync(path.join(root, ".env"))) {
  console.error(`[autosignup] Refusing to start: ${path.join(root, ".env")} is missing. Copy .env.example.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) {
  console.error("[autosignup] Refusing to start: run `npm run build` first.")
  process.exit(1)
}

module.exports = {
  apps: [
    {
      name: "autosignup",
      cwd: root,
      script: "node_modules/next/dist/bin/next",
      // Localhost only. Reach it with: ssh -N -L 3003:127.0.0.1:3003 <prod-host>
      args: "start -H 127.0.0.1 -p 3003",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 15000,
      env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
}
