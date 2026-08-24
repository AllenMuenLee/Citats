import { Mistral } from "@mistralai/mistralai";
import { readMistralConfig } from "../../../../../server/ai/mistral";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_DISPLAY_FILE_BYTES = 20 * 1024 * 1024;

export async function GET(_request: Request, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await context.params;
  if (!FILE_ID.test(fileId)) return Response.json({ error: "File identifier is invalid." }, { status: 400 });
  try {
    const config = readMistralConfig();
    const client = new Mistral({ apiKey: config.apiKey, serverURL: config.baseUrl.origin, timeoutMs: config.timeoutMs });
    const metadata = await client.files.retrieve({ fileId }, { signal: _request.signal });
    if (metadata.deleted || metadata.sizeBytes > MAX_DISPLAY_FILE_BYTES) return Response.json({ error: "Generated file is unavailable for display." }, { status: 413 });
    const body = await client.files.download({ fileId }, { signal: _request.signal });
    const filename = metadata.filename.replaceAll(/[\r\n"\\]/g, "_");
    return new Response(body, {
      headers: {
        "content-type": metadata.mimetype ?? "application/octet-stream",
        "content-length": String(metadata.sizeBytes),
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      },
    });
  } catch {
    return Response.json({ error: "Generated file could not be retrieved." }, { status: 502 });
  }
}
