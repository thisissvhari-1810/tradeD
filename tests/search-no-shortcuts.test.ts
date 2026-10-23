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

  // Chart drawing editing has its own shortcuts (undo / redo, delete, duplicate, lock, nudge), requested for
  // the drawing system. Their hints appear only in the drawing style bar; nothing else in the app has shortcuts.
  const DRAWING_HINTS = /drawing-edit-bar\.tsx$/;

  it("shows no key hints anywhere in the UI except the drawing style bar", () => {
    for (const { path, text } of files) {
      if (DRAWING_HINTS.test(path)) continue;
      expect(text, path).not.toMatch(/<kbd|aria-keyshortcuts|Ctrl\s*\+|Keyboard shortcuts|shortcut=/);
    }
    expect(files.find(({ path }) => DRAWING_HINTS.test(path))?.text).not.toMatch(/<kbd|Keyboard shortcuts|shortcut=/);
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
    expect(rule).toContain("height: 2.5rem");
    expect(rule).toContain("padding: 0 0.75rem 0 2.5rem");
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
  });

  it("is at least 200px on desktop (so the index chips fit) and an icon button on small screens", () => {
    expect(search).toContain("w-[clamp(12.5rem,20vw,23.75rem)]");
    expect(search).toMatch(/hidden w-\[clamp[^"]*md:block/);
    expect(search).toMatch(/md:hidden" aria-label="Search stocks, options and pages"/);
  });

  it("groups results into Symbols and Pages with a No results state", () => {
    expect(search).toContain('(["Symbols", "Pages"] as const)');
    expect(search).toContain("No results");
    expect(search).toContain("onClick={() => pick(entry)}");
  });
});
