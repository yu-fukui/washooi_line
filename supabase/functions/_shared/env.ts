export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export function optEnv(name: string, fallback: string): string {
  return Deno.env.get(name) || fallback;
}

/** pg_cron からの呼び出しかを x-cron-secret ヘッダーで確認する */
export function isCronRequest(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  return !!secret && req.headers.get("x-cron-secret") === secret;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
