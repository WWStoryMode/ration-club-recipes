import { createServer } from "node:http";

export interface CallbackResult {
  code: string;
  state: string | null;
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${msg}</p></body>`;

/**
 * Tiny one-shot HTTP server on 127.0.0.1 that waits for the OAuth redirect to /callback.
 * Resolves with the code, or rejects on an OAuth error or a timeout. Closes itself either way.
 */
export function waitForCallback(port: number, timeoutMs = 5 * 60_000) {
  let ready!: () => void;
  let cancel: () => void = () => {};
  const listening = new Promise<void>((r) => (ready = r));

  const result = new Promise<CallbackResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.writeHead(error || !code ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
      if (error || !code) {
        res.end(page("Sign-in failed", "Return to the terminal for details. You can close this tab."));
        finish(() => reject(new Error(`Authorization failed: ${error ?? "no code"} ${url.searchParams.get("error_description") ?? ""}`.trim())));
      } else {
        res.end(page("Signed in", "Ration Club Recipes is connected to docs.plus. You can close this tab."));
        finish(() => resolve({ code, state: url.searchParams.get("state") }));
      }
    });
    const timer = setTimeout(() => finish(() => reject(new Error("Timed out waiting for the browser sign-in."))), timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      fn();
    };
    cancel = () => finish(() => reject(new Error("cancelled")));
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is busy. Is another \`pnpm login\` running?`) : err);
    });
    server.listen(port, "127.0.0.1", ready);
  });

  result.catch(() => {}); // callers that cancel never await result
  return { listening, result, close: () => cancel() };
}
