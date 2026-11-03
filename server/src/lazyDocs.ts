import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DocsPlus, DocsPlusError } from "./docsPlus.js";
import { connect, defaultStore, makeProvider } from "./mcp.js";
import type { DocsPort } from "./recipes.js";

/**
 * Connects to docs.plus on first use (non-interactive: a missing login throws NeedsLoginError) and
 * reuses the connection. After a transport or network failure the connection is dropped, so the next call reconnects.
 */
export class LazyDocs implements DocsPort {
  private conn?: Promise<{ client: Client; dp: DocsPlus }>;

  constructor(private readonly slug: string) {}

  private get() {
    this.conn ??= connect(makeProvider(defaultStore())).then(({ client }) => ({ client, dp: new DocsPlus(client, this.slug) }));
    return this.conn;
  }

  private async run<T>(fn: (dp: DocsPlus) => Promise<T>): Promise<T> {
    try {
      return await fn((await this.get()).dp);
    } catch (err) {
      if (!(err instanceof DocsPlusError)) {
        const old = this.conn;
        this.conn = undefined;
        old?.then(({ client }) => client.close()).catch(() => {});
      }
      throw err;
    }
  }

  getOutline: DocsPort["getOutline"] = () => this.run((dp) => dp.getOutline());
  readSection: DocsPort["readSection"] = (id) => this.run((dp) => dp.readSection(id));
  editBlocks: DocsPort["editBlocks"] = (p) => this.run((dp) => dp.editBlocks(p));
  appendRecipe: DocsPort["appendRecipe"] = (t, b, l) => this.run((dp) => dp.appendRecipe(t, b, l));
}
