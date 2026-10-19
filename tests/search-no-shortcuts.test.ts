import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("no keyboard shortcuts", () => {
  const files = sources(root).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("shows no key hints anywhere in the UI", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/<kbd|aria-keyshortcuts|Ctrl\s*\+|Keyboard shortcuts|shortcut=/);
    }
  });

  it("has no global shortcut listeners", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/td-ticket|key\.toLowerCase\(\) === "(k|b|s|z|y)"|event\.key === "\?"|event\.key === "\/"/);
    }
    expect(existsSync(join(root, "components", "shortcuts-sheet.tsx"))).toBe(false);
    expect(existsSync(join(root, "components", "command-palette.tsx"))).toBe(false);
  });
});

describe("top-bar search", () => {
  const search = read("components/global-search.tsx");
  const css = read("app/globals.css");

  it("uses a fixed 40px field with a left icon and ellipsised placeholder", () => {
    expect(search).toContain('"Search stocks, options, pages"');
    const rule = css.slice(css.indexOf("input.top-search {"), css.indexOf("}", css.indexOf("input.top-search {")));
    expect(rule).toContain("height: 40px");
    expect(rule).toContain("padding: 0 12px 0 40px");
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
  });

  it("is at least 280px on desktop and an icon button on small screens", () => {
    expect(search).toContain("w-[clamp(280px,26vw,380px)]");
    expect(search).toMatch(/hidden w-\[clamp[^"]*md:block/);
    expect(search).toMatch(/md:hidden" aria-label="Search stocks, options and pages"/);
  });

  it("groups results into Symbols and Pages with a No results state", () => {
    expect(search).toContain('(["Symbols", "Pages"] as const)');
    expect(search).toContain("No results");
    expect(search).toContain("onClick={() => pick(entry)}");
  });
});
