import { NextResponse } from "next/server"
import { fail, guard } from "@/lib/http"
import { previewPlan, type PlanInput } from "@/lib/plan"

export async function POST(req: Request) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { plan } = (await req.json()) as { plan: PlanInput }
    return NextResponse.json(await previewPlan(plan))
  } catch (err) {
    return fail(err)
  }
}
