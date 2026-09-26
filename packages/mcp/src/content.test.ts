import { rule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";

// The teaching layer shows agents complete rules to adapt. Every one of
// them must be a document the rule language accepts.

const documents = (markdown: string) =>
  [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((m) => JSON.parse(m[1]!) as Record<string, unknown>)
    .filter((block) => block.version === 1);

describe("the teaching content", () => {
  it("loads every file, with the rule schema", async () => {
    const content = await loadContent();
    expect(content.instructions).toMatch(/^Tripwire watches/);
    expect(content.prompt).toContain("{{contract}}");
    for (const guide of Object.values(content.guides)) {
      expect(guide.length).toBeGreaterThan(500);
    }
    expect(JSON.parse(content.schema)).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["version", "trip_when"]) as unknown,
    });
  });

  it("shows only rules the language accepts", async () => {
    const { guides } = await loadContent();
    const all = [
      ...documents(guides.examples),
      ...documents(guides["rule-language"]),
    ];
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const document of all) {
      const parsed = rule.safeParse(document);
      expect(
        parsed.success ? [] : parsed.error.issues,
        String(document.name),
      ).toEqual([]);
    }
  });

  it("proposes nothing but notifications", async () => {
    const { guides } = await loadContent();
    for (const document of documents(guides.examples)) {
      expect(document.on_trip).toMatchObject({ action: "notify" });
    }
  });
});
