export type TestMdStep = { n: number; verifies: string[]; text: string };
export type ParsedTestMd = { id: string | null; title: string; steps: TestMdStep[] };

/**
 * Parse a Kane-designed `_test.md`: frontmatter `assurance.id`, the `# title`,
 * and `## Step N [— assert] @verifies ac-1, ac-2` sections.
 */
export function parseTestMd(text: string): ParsedTestMd {
  const src = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---/.exec(src);
  const id = (fm ? /^\s*id:\s*(\S+)/m.exec(fm[1] ?? "")?.[1] : undefined) ?? null;
  const body = fm ? src.slice(fm[0].length) : src;

  let title = "";
  const steps: TestMdStep[] = [];
  let cur: { n: number; verifies: string[]; lines: string[] } | null = null;
  const flush = () => {
    if (cur) steps.push({ n: cur.n, verifies: cur.verifies, text: cur.lines.join("\n").trim() });
    cur = null;
  };
  for (const line of body.split("\n")) {
    const h = /^##\s+Step\s+(\d+)\b(.*)$/i.exec(line);
    if (h) {
      flush();
      const verifies: string[] = [];
      const tag = /@verifies\s+(.*)$/.exec(h[2] ?? "");
      for (const ac of tag?.[1]?.match(/ac-\d+/g) ?? []) if (!verifies.includes(ac)) verifies.push(ac);
      cur = { n: Number(h[1]), verifies, lines: [] };
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (!title) {
      const t = /^#\s+(.*)$/.exec(line);
      if (t) title = (t[1] ?? "").trim();
    }
  }
  flush();
  return { id, title, steps };
}
