import { connection } from "next/server"
import { templateXlsx } from "@/lib/export"
import { guard } from "@/lib/http"

export async function GET(req: Request) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  return new Response(new Uint8Array(await templateXlsx()), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="autosignup-import-template.xlsx"',
      "cache-control": "no-store",
    },
  })
}
