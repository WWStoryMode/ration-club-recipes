/**
 * Optional (CHAT_SUMMARIES=1): after a change reaches the document, post a one-line note in the docs.plus chat,
 * so people following the booklet see what changed. Best effort: a failed note never fails the save.
 *
 * docs.plus only lets us post in a room that already exists, and rooms start the first time someone opens chat
 * on a heading. So a note goes to the recipe's room if it has one, otherwise the booklet heading's room,
 * otherwise nowhere (logged once). Open chat on the booklet heading once in docs.plus to give notes a home.
 *
 * Notes never quote visitors' text: only recipe and section names, which have already been checked.
 */

export interface ChatPort {
  listChatRooms(): Promise<string>;
  postChatMessage(sectionId: string, text: string): Promise<void>;
}

export interface ChatNotifier {
  /** Queue a note for a recipe's room (or the booklet's). Returns at once; notes are posted one at a time in the background. */
  notify(recipeId: string | undefined, text: string): void;
}

export const noChat: ChatNotifier = { notify: () => {} };

const ID_CHARS = "A-Za-z0-9_-";
const mentions = (rooms: string, id: string) =>
  new RegExp(`(^|[^${ID_CHARS}])${id.replace(/[^A-Za-z0-9_-]/g, "")}($|[^${ID_CHARS}])`).test(rooms);

export class ChatSummaries implements ChatNotifier {
  private chain: Promise<void> = Promise.resolve();
  private rooms?: { at: number; text: string };
  private warned = new Set<string>();
  private readonly now: () => number;
  private bookletId?: string;

  constructor(
    private readonly o: {
      chat: ChatPort;
      /** The booklet heading's section id (its room is the fallback). Looked up once, when first needed. */
      booklet: () => Promise<string | undefined>;
      /** How long the room list is trusted. A new room appears after this long. */
      roomsCacheMs?: number;
      now?: () => number;
    },
  ) {
    this.now = o.now ?? Date.now;
  }

  notify(recipeId: string | undefined, text: string): void {
    this.chain = this.chain.then(() => this.post(recipeId, text)).catch((err) => {
      console.warn(`[chat] could not post a summary: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Resolves when every queued note has been tried (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async roomList(): Promise<string> {
    if (!this.rooms || this.now() - this.rooms.at >= (this.o.roomsCacheMs ?? 5 * 60_000)) {
      this.rooms = { at: this.now(), text: await this.o.chat.listChatRooms() };
    }
    return this.rooms.text;
  }

  private async post(recipeId: string | undefined, text: string) {
    this.bookletId ??= await this.o.booklet();
    const ids = [recipeId, this.bookletId].filter((x): x is string => !!x);
    const list = await this.roomList();
    const room = ids.find((id) => mentions(list, id));
    if (!room) {
      const key = ids.join(",");
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn("[chat] no chat room to post in yet. Open the chat on the booklet heading once in docs.plus to create one.");
      }
      return;
    }
    await this.o.chat.postChatMessage(room, plain(text));
  }
}

/** Plain text, one line, no @ (docs.plus removes them anyway), at most 500 characters. */
export function plain(text: string): string {
  return text.replace(/@/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export const chatText = {
  updated: (recipe: string, section: string | undefined, approved: boolean) =>
    `Recipe updated through Ration Club Recipes: "${recipe}"${section && section !== recipe ? ` › ${section}` : ""}.${approved ? " Approved by an organiser." : ""}`,
  added: (recipe: string, approved: boolean) =>
    `New recipe added through Ration Club Recipes: "${recipe}".${approved ? " Approved by an organiser." : ""}`,
};
