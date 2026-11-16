import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { CommentaryModel } from "./commentary.js";

const CommentarySchema = z.object({
  arabic: z.string(),
  english: z.string(),
});

export const DEFAULT_COMMENTARY_MODEL = "claude-opus-5-5";

/**
 * Claude implementation of the commentary model. Credentials come from the
 * environment (ANTHROPIC_API_KEY), never from the database or the input.
 * Network/rate-limit errors are retried by the SDK (maxRetries); anything
 * else (including a refusal) throws, and generateCommentary falls back to
 * the next attempt or the deterministic template.
 */
export class ClaudeCommentaryModel implements CommentaryModel {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(opts: { client?: Anthropic; model?: string } = {}) {
    this.client = opts.client ?? new Anthropic({ maxRetries: 3 });
    this.name = opts.model ?? DEFAULT_COMMENTARY_MODEL;
  }

  async generate(req: { system: string; user: string }): Promise<{ ar: string; en: string }> {
    const response = await this.client.messages.parse({
      model: this.name,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: "medium", format: zodOutputFormat(CommentarySchema) },
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`Model declined (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Model output was cut off (max_tokens)");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("Model output did not match the expected JSON shape");
    return { ar: parsed.arabic, en: parsed.english };
  }
}
