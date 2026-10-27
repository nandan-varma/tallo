import axe from "axe-core";
import { expect } from "vitest";

const MAX_HTML = 160;

/**
 * Runs axe over a rendered tree and fails with each violation's rule, its help text and the first node it
 * flagged. Colour contrast and landmark regions are off: jsdom computes neither colours nor layout.
 */
export async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  const lines = results.violations.map((violation) => {
    const html = violation.nodes[0]?.html ?? "";
    const shown = html.length > MAX_HTML ? `${html.slice(0, MAX_HTML - 1)}…` : html;
    return `- ${violation.id}: ${violation.help}\n    ${shown}`;
  });
  expect(
    results.violations.length,
    `${results.violations.length} accessibility violation(s):\n${lines.join("\n")}`,
  ).toBe(0);
}
