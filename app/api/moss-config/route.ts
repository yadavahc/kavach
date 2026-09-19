import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The browser SDK needs a Moss project id and key to download the indexes into
 * the page. They are read from server env at request time, so the key is not
 * baked into the static bundle and can be rotated without a rebuild. The key
 * is still visible to the browser: use a Moss project that holds only these
 * public-corpus indexes.
 */
export function GET() {
  const projectId = process.env.MOSS_PROJECT_ID?.trim();
  const projectKey = process.env.MOSS_PROJECT_KEY?.trim();
  if (!projectId || !projectKey) {
    return NextResponse.json({ error: "MOSS_PROJECT_ID and MOSS_PROJECT_KEY are not set on the server." }, { status: 503 });
  }
  return NextResponse.json({ projectId, projectKey }, { headers: { "cache-control": "no-store" } });
}
