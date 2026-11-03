import { useEffect, useRef } from "react";

/** Cloudflare Turnstile, loaded only when the server gives a site key. Calls onToken with each new token ("" when it expires). */

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id: string): void;
      remove(id: string): void;
    };
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | undefined;

function load(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = undefined;
      reject(new Error("turnstile"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile(props: { siteKey: string; onToken: (token: string) => void; resetKey: number; onError: (msg: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | undefined>(undefined);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    let gone = false;
    load()
      .then(() => {
        if (gone || !el.current || !window.turnstile) return;
        id.current = window.turnstile.render(el.current, {
          sitekey: props.siteKey,
          callback: (t: string) => cb.current.onToken(t),
          "expired-callback": () => cb.current.onToken(""),
          "error-callback": () => cb.current.onError("The human check couldn't load. Please reload the page and try again."),
        });
      })
      .catch(() => cb.current.onError("The human check couldn't load. Please check your connection, or turn off blockers for this site, then reload."));
    return () => {
      gone = true;
      if (id.current) window.turnstile?.remove(id.current);
      id.current = undefined;
    };
  }, [props.siteKey]);

  // A token can be used once: get a fresh one after every submit.
  useEffect(() => {
    if (props.resetKey && id.current) {
      cb.current.onToken("");
      window.turnstile?.reset(id.current);
    }
  }, [props.resetKey]);

  return <div ref={el} className="turnstile" />;
}
