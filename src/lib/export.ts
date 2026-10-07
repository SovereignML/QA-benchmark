import ExcelJS from "exceljs"
import type { Job, JobUser } from "./store"
import { LOGIN_URL, timeZone } from "./target"

// The record of every test user: one row per planned user across the chosen
// jobs, with everything AutoSignUp knows about it.
const COLUMNS: { header: string; width: number; get: (u: JobUser, j: Job) => string | number | boolean }[] = [
  { header: "Email", width: 34, get: (u) => u.email },
  { header: "Password", width: 18, get: (u) => u.password },
  { header: "Name", width: 22, get: (u) => u.name },
  { header: "Location", width: 16, get: (u) => u.location },
  { header: "Stage", width: 12, get: (u) => u.state },
  { header: "Planned signup (UTC)", width: 22, get: (u) => u.plannedAt },
  { header: "Signed up at (UTC)", width: 22, get: (u) => u.signedUpAt ?? "" },
  { header: "Will verify", width: 11, get: (u) => (u.willVerify ? "yes" : "no") },
  { header: "Verify delay (min)", width: 16, get: (u) => (u.willVerify ? u.verifyDelayMin : "") },
  { header: "Verified at (UTC)", width: 22, get: (u) => u.verifiedAt ?? "" },
  { header: "Deleted at (UTC)", width: 22, get: (u) => u.deletedAt ?? "" },
  { header: "Deferred (days)", width: 14, get: (u) => u.deferrals },
  { header: "User ID", width: 28, get: (u) => u.userId ?? "" },
  { header: "Team ID", width: 28, get: (u) => u.teamId ?? "" },
  { header: "Free agent limit", width: 14, get: (_u, j) => (j.freeAgentLimit ?? "default") },
  { header: "Job", width: 26, get: (_u, j) => j.id },
  { header: "Job label", width: 18, get: (_u, j) => j.label },
  { header: "Error", width: 30, get: (u) => u.error ?? "" },
  { header: "Login URL", width: 34, get: () => LOGIN_URL },
]

function rows(jobs: Job[]) {
  return jobs.flatMap((j) => j.users.map((u) => COLUMNS.map((c) => c.get(u, j))))
}

function csvCell(v: string | number | boolean) {
  const s = String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s // no spreadsheet formula injection
  return `"${safe.replace(/"/g, '""')}"`
}

export function recordsCsv(jobs: Job[]): string {
  return [COLUMNS.map((c) => c.header), ...rows(jobs)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"
}

export async function recordsXlsx(jobs: Job[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()
  const ws = wb.addWorksheet("Test users")
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }))
  ws.getRow(1).font = { bold: true }
  for (const r of rows(jobs)) ws.addRow(r)
  ws.views = [{ state: "frozen", ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }

  const info = wb.addWorksheet("About")
  info.addRows([
    ["Generated", new Date().toISOString()],
    ["Time zone for daily cap", timeZone()],
    ["Jobs", jobs.map((j) => j.id).join(", ")],
    ["Note", "Passwords are plain text. Prod stores only the bcrypt hash. Keep this file private."],
  ])
  info.getColumn(1).width = 26
  info.getColumn(2).width = 90
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Blank import template: the columns the importer understands. */
export async function templateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("Emails")
  ws.columns = [
    { header: "Email", width: 34 },
    { header: "Name", width: 24 },
    { header: "Location", width: 18 },
  ]
  ws.getRow(1).font = { bold: true }
  const help = wb.addWorksheet("How to fill")
  help.addRows([
    ["Email", "Required. One per row. Duplicates and invalid addresses are dropped on import."],
    ["Name", "Optional, at least 2 characters (same rule as the signup form). Blank = derived from the email."],
    ["Location", "Optional. Kept in AutoSignUp's records only; prod has no location field."],
    ["Example", "qa.tester1@yourdomain.com | Jane Tester | Dhaka"],
  ])
  help.getColumn(1).width = 12
  help.getColumn(2).width = 90
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Reads the first sheet of an uploaded .xlsx into a string table. */
export async function xlsxToTable(buf: ArrayBuffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const out: string[][] = []
  ws.eachRow((row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const v = cell.value
      let s = ""
      if (v == null) s = ""
      else if (typeof v === "object" && "text" in v) s = String(v.text)
      else if (typeof v === "object" && "result" in v) s = String(v.result ?? "")
      else s = String(v)
      cells[col - 1] = s.replace(/^mailto:/i, "").trim()
    })
    out.push(Array.from(cells, (c) => c ?? ""))
  })
  return out
}
