import { NextResponse } from "next/server"
import { fail, guard } from "@/lib/http"
import { saveSettings, withLock } from "@/lib/store"
import { MAX_DAILY_CAP } from "@/lib/target"

export async function PUT(req: Request) {
  const blocked = guard(req)
  if (blocked) return blocked
  try {
    const { dailyCap } = (await req.json()) as { dailyCap?: number }
    if (!Number.isInteger(dailyCap) || dailyCap! < 1 || dailyCap! > MAX_DAILY_CAP) {
      throw new Error(`Daily cap must be a whole number from 1 to ${MAX_DAILY_CAP}.`)
    }
    await withLock(() => saveSettings({ dailyCap: dailyCap! }))
    return NextResponse.json({ dailyCap })
  } catch (err) {
    return fail(err)
  }
}
