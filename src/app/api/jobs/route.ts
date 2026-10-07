import { NextResponse, connection } from "next/server"
import { verifiedPool } from "@/lib/db"
import { fail, guard } from "@/lib/http"
import { createJob, type PlanInput } from "@/lib/plan"
import { tick } from "@/lib/scheduler"
import { listJobs } from "@/lib/store"
import { summarize } from "@/lib/summary"

export async function GET(req: Request) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  return NextResponse.json((await listJobs()).map(summarize))
}

export async function POST(req: Request) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { plan, confirm } = (await req.json()) as { plan: PlanInput; confirm?: string }
    await verifiedPool(true)
    const job = await createJob(plan, confirm ?? "")
    void tick() // start immediately if the window has begun
    return NextResponse.json(summarize(job))
  } catch (err) {
    return fail(err)
  }
}
