import { rule } from "@tripwire/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The teaching layer is versioned content, reviewed like code: markdown
// files beside this package's source, copied beside the executable when
// the command line is bundled.

export type GuideName =
  "method" | "rule-language" | "metrics" | "examples" | "pitfalls";

export interface Content {
  instructions: string;
  /** The propose_rules prompt; `{{contract}}` marks the argument. */
  prompt: string;
  guides: Record<GuideName, string>;
  /** The rule document's JSON schema, as text. */
  schema: string;
}

/** Where the content files are when running from source. */
export const CONTENT_DIR = fileURLToPath(
  new URL("../content/", import.meta.url),
);

export async function loadContent(dir: string = CONTENT_DIR): Promise<Content> {
  const read = (name: string) => readFile(join(dir, `${name}.md`), "utf8");
  const [instructions, prompt, method, language, metrics, examples, pitfalls] =
    await Promise.all(
      [
        "instructions",
        "prompt",
        "method",
        "rule-language",
        "metrics",
        "examples",
        "pitfalls",
      ].map(read),
    );
  return {
    instructions: instructions!.trim(),
    prompt: prompt!.trim(),
    guides: {
      method: method!,
      "rule-language": language!,
      metrics: metrics!,
      examples: examples!,
      pitfalls: pitfalls!,
    },
    schema: JSON.stringify(
      z.toJSONSchema(rule, { io: "input", unrepresentable: "any" }),
      null,
      2,
    ),
  };
}
