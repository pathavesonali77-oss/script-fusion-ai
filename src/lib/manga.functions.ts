import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseScript } from "./script";
import { buildCharacterBible, writePrompts, generateImage, generateCheckedImage } from "./manga.server";
import { geminiStatus } from "./gemini.server";

const SegmentSchema = z.object({
  index: z.number(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const analyzeScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ script: z.string().min(5) }).parse(d))
  .handler(async ({ data }) => {
    const segments = parseScript(data.script);
    if (segments.length === 0) {
      throw new Error(
        "No timestamps found. Each line needs a time like 0:00, (0:00) or [0:00].",
      );
    }
    const bible = await buildCharacterBible(data.script);
    return { segments, bible, engine: geminiStatus() };
  });

/**
 * One storyboard pass.
 *
 * The model is handed the ENTIRE script every time (no chunking, no chunk
 * briefs) and asked for the prompts of one range of line numbers, because the
 * answer — not the input — is what has a size ceiling. Continuity comes from
 * the model reading the whole story.
 */
export const promptsForRange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string(),
        /** 1-based, inclusive. */
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        segments: z.array(SegmentSchema).min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const prompts = await writePrompts(data.bible, data.segments, data.from, data.to);
    return { from: data.from, to: data.to, prompts, engine: geminiStatus() };
  });

export const renderImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        prompt: z.string().min(5),
        seed: z.number().int(),
        bible: z.string().optional(),
        slot: z.number().int().min(0).default(0),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const url = await generateImage(data.prompt, data.seed, data.slot, data.bible);
    return { url };
  });

/**
 * Renders several panels in one round trip. Failures are reported per item so
 * one bad panel never fails the group.
 */
export const renderBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string().optional(),
        jobs: z
          .array(
            z.object({
              index: z.number().int(),
              prompt: z.string().min(5),
              seed: z.number().int(),
              slot: z.number().int().min(0).default(0),
              line: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const results = await Promise.all(
      data.jobs.map(async (job) => {
        try {
          const out = await generateCheckedImage(
            job.prompt,
            job.seed,
            job.slot,
            data.bible,
            job.line,
          );
          return { index: job.index, url: out.url, prompt: out.prompt };
        } catch (e) {
          return {
            index: job.index,
            url: null as string | null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    return { results };
  });
