import { connection, type NextRequest } from "next/server"
import { recordsCsv, recordsXlsx } from "@/lib/export"
import { fail, guard } from "@/lib/http"
import { listJobs, loadJob } from "@/lib/store"

// ?job=<id> for one job, otherwise every job. ?format=csv|xlsx (default xlsx).
export async function GET(req: NextRequest) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  const jobId = req.nextUrl.searchParams.get("job")
  let jobs
  try {
    jobs = jobId ? [await loadJob(jobId)] : await listJobs()
  } catch (err) {
    return fail(err, 404)
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
  const base = `atlasagents-test-users-${jobId ?? "all"}-${stamp}`
  const headers = { "cache-control": "no-store" }
  if (req.nextUrl.searchParams.get("format") === "csv") {
    return new Response(recordsCsv(jobs), {
      headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${base}.csv"` },
    })
  }
  return new Response(new Uint8Array(await recordsXlsx(jobs)), {
    headers: {
      ...headers,
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${base}.xlsx"`,
    },
  })
}
