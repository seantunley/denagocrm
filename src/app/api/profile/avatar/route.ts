import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { readFile } from "@/lib/storage";

export async function GET() {
  try {
    const user = await requireApiUser();
    if (!user.avatarRef || !user.avatarMimeType) {
      return NextResponse.json({ error: "Profile photo not found" }, { status: 404 });
    }
    const bytes = await readFile(user.avatarRef);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": user.avatarMimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Profile photo unavailable" }, { status: 404 });
  }
}
