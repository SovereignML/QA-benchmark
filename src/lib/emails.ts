import { z } from "zod"
import { MAX_POOL_SIZE } from "./target"

export type InputRow = { email: string; name: string; location: string }

export type ParsedRow = InputRow & {
  line: number
  status: "valid" | "invalid" | "duplicate"
  reason?: string
}

export type ParseResult = {
  rows: ParsedRow[]
  valid: InputRow[]
  counts: { total: number; valid: number; invalid: number; duplicate: number }
  overLimit: boolean
}

const emailSchema = z.email()

// atlasagents-app's registerSchema requires name.length >= 2.
export function defaultName(email: string): string {
  const local = email.split("@")[0].replace(/[._+-]+/g, " ").trim()
  return local.length >= 2 ? local : `user ${local}`.trim()
}

/**
 * Normalizes raw rows (from paste, CSV or XLSX) into the seed list. Emails are
 * lowercased because atlasagents-app looks users up by exact email match.
 */
export function normalizeRows(raw: { email?: string; name?: string; location?: string }[]): ParseResult {
  const seen = new Set<string>()
  const rows: ParsedRow[] = []
  const valid: InputRow[] = []

  raw.forEach((r, i) => {
    const email = (r.email ?? "").trim().toLowerCase()
    const name = (r.name ?? "").trim()
    const location = (r.location ?? "").trim()
    if (!email) return

    const base = { email, name: name.length >= 2 ? name : defaultName(email), location, line: i + 1 }
    if (!emailSchema.safeParse(email).success) {
      rows.push({ ...base, status: "invalid", reason: "Not a valid email" })
    } else if (seen.has(email)) {
      rows.push({ ...base, status: "duplicate", reason: "Already in this list" })
    } else {
      seen.add(email)
      rows.push({ ...base, status: "valid" })
      valid.push({ email: base.email, name: base.name, location: base.location })
    }
  })

  return {
    rows,
    valid,
    counts: {
      total: rows.length,
      valid: valid.length,
      invalid: rows.filter((r) => r.status === "invalid").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
    },
    overLimit: valid.length > MAX_POOL_SIZE,
  }
}

const HEADER_ALIASES: Record<string, "email" | "name" | "location"> = {
  email: "email",
  "e-mail": "email",
  mail: "email",
  "email address": "email",
  name: "name",
  "full name": "name",
  location: "location",
  city: "location",
  country: "location",
}

/** Splits one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** Maps a table (first row may be a header) onto email/name/location. */
export function tableToRaw(table: string[][]): { email?: string; name?: string; location?: string }[] {
  if (table.length === 0) return []
  const header = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()])
  const hasHeader = header.includes("email")
  const cols: ("email" | "name" | "location" | undefined)[] = hasHeader ? header : ["email", "name", "location"]
  const body = hasHeader ? table.slice(1) : table
  return body.map((cells) => {
    const r: { email?: string; name?: string; location?: string } = {}
    cells.forEach((c, i) => {
      const key = cols[i]
      if (key && !r[key]) r[key] = c
    })
    // Headerless single-column input where the email isn't first: find it.
    if (!hasHeader && r.email && !r.email.includes("@")) {
      const found = cells.find((c) => c.includes("@"))
      if (found) r.email = found
    }
    return r
  })
}

/**
 * Parses pasted text or CSV. Accepts one email per line, or comma/semicolon/
 * tab separated rows with an optional header.
 */
export function parseText(text: string): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim())
  const sample = lines.slice(0, 5).join("\n")
  const sep = sample.includes("\t") ? "\t" : sample.includes(";") && !sample.includes(",") ? ";" : ","
  // A paste of "a@x.com, b@y.com" on one line is a list, not a row.
  if (lines.length === 1 && (lines[0].match(/@/g)?.length ?? 0) > 1) {
    return normalizeRows(lines[0].split(/[,;\s]+/).map((email) => ({ email })))
  }
  return normalizeRows(tableToRaw(lines.map((l) => splitCsvLine(l, sep))))
}
