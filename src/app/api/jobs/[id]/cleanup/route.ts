import { NextResponse, type NextRequest } from "next/server"
import { planCleanup, runCleanup } from "@/lib/cleanup"
import { verifiedPool } from "@/lib/db"
import { fail, guard } from "@/lib/http"

// { action: "plan" } → what would be deleted (read-only)
// { action: "run", expected, confirm } → cancel pending + delete, one transaction
export async function POST(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]/cleanup">) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { id } = await ctx.params
    const body = (await req.json()) as { action?: string; expected?: number; confirm?: string }
    const pool = await verifiedPool()
    if (body.action === "run") {
      if (typeof body.expected !== "number") throw new Error("Review the cleanup first.")
      const res = await runCleanup(pool, id, body.expected, body.confirm ?? "")
      return NextResponse.json({ deleted: res.deleted })
    }
    return NextResponse.json(await planCleanup(pool, id))
  } catch (err) {
    return fail(err)
  }
}
