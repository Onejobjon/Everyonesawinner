// Diagnostic marker: proves whether Vercel's own builder deploys api/*
// functions for this project (vs our build-vercel.sh output, which routes
// everything to /render). Lead uses this to identify who serves /api/*.
export default function handler(_req: any, res: any): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, from: "vercel-api-function", build: "2026-10-27T14:05Z" }));
}
