---
name: Create architecture diagram
description: Create an accessible SVG architecture, CONOPS, or workflow diagram grounded in project evidence.
argument-hint: <diagram purpose and output path>
---

# Create an architecture diagram

Create a self-contained SVG that can be safely previewed by AAA.

1. Search and read the relevant project background, evidence, and package documents.
2. Distinguish verified facts from assumptions. Do not invent components, boundaries, data flows, or trust relationships.
3. Write the SVG to a descriptive project-relative `.svg` path, normally under `architecture/` or `background-docs/`.
4. Use a `viewBox`, readable text, high-contrast colors that work on light and dark surrounding surfaces, and a `<title>` plus `<desc>` for accessibility.
5. Use SVG presentation attributes directly. Do not use scripts, event handlers, `foreignObject`, `<style>`, external images, external links, fonts, stylesheets, `data:` URLs, or CSS `url(...)`.
6. Add a sibling Markdown file that lists:
   - source project files used;
   - verified architecture facts;
   - assumptions and unknowns;
   - the generated SVG path.
7. Read the completed files and verify that every label fits and every assertion is traceable.

For CONOPS diagrams, show actors, operational steps, decision points, and system boundaries. For architecture diagrams, show components, trust boundaries, interfaces, and directional data flows only when supported by project information.
