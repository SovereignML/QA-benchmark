import { NextResponse, connection } from "next/server"
import { normalizeRows, parseText, tableToRaw, type ParseResult } from "@/lib/emails"
import { xlsxToTable } from "@/lib/export"
import { fail, guard } from "@/lib/http"
import { clearPool, importRows, poolSummary } from "@/lib/pool"

const MAX_UPLOAD = 10 * 1024 * 1024

export async function GET(req: Request) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  return NextResponse.json(await poolSummary())
}

// JSON { text } from the paste box, or multipart `file` (.xlsx / .csv / .txt).
// `?check=1` only parses and reports; nothing is added.
export async function POST(req: Request) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const check = new URL(req.url).searchParams.get("check") === "1"
    let parsed: ParseResult
    const type = req.headers.get("content-type") ?? ""
    if (type.includes("multipart/form-data")) {
      const file = (await req.formData()).get("file")
      if (!(file instanceof File)) throw new Error("No file uploaded.")
      if (file.size > MAX_UPLOAD) throw new Error("File is larger than 10 MB.")
      const name = file.name.toLowerCase()
      if (name.endsWith(".xls")) throw new Error("Old .xls isn't supported — save as .xlsx or .csv.")
      parsed = name.endsWith(".xlsx")
        ? normalizeRows(tableToRaw(await xlsxToTable(await file.arrayBuffer())))
        : parseText(await file.text())
    } else {
      const { text } = (await req.json()) as { text?: string }
      parsed = parseText(text ?? "")
    }
    if (check) return NextResponse.json({ parsed })
    if (parsed.valid.length === 0) throw new Error("No valid emails found.")
    const result = await importRows(parsed.valid)
    return NextResponse.json({ parsed: { counts: parsed.counts }, result })
  } catch (err) {
    return fail(err)
  }
}

export async function DELETE(req: Request) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const which = new URL(req.url).searchParams.get("which")
    if (which !== "available" && which !== "exists" && which !== "unused") throw new Error("Bad request.")
    return NextResponse.json(await clearPool(which))
  } catch (err) {
    return fail(err)
  }
}
