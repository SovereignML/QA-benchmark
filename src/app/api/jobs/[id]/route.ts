import { NextResponse, connection, type NextRequest } from "next/server"
import { fail, guard } from "@/lib/http"
import { controlJob, tick } from "@/lib/scheduler"
import { loadJob } from "@/lib/store"
import { summarize } from "@/lib/summary"

export async function GET(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { id } = await ctx.params
    const job = await loadJob(id)
    return NextResponse.json({ ...summarize(job), users: job.users, log: job.log })
  } catch (err) {
    return fail(err, 404)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { id } = await ctx.params
    const { action } = (await req.json()) as { action?: string }
    if (action !== "pause" && action !== "resume" && action !== "cancel") throw new Error("Bad action.")
    const job = await controlJob(id, action)
    if (action === "resume") void tick()
    return NextResponse.json(summarize(job))
  } catch (err) {
    return fail(err)
  }
}
