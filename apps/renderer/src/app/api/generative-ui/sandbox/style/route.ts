import { NextResponse } from "next/server";
export function GET(): NextResponse { return new NextResponse("html,body,#root{margin:0;min-height:100%;font-family:system-ui,sans-serif}body{overflow-x:hidden}", { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } }); }
