import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { candidateFiles, collectDiagrams, validateDiagramSyntax } from "./check-documentation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export async function createArchitecturePreview(directory = root) {
  const diagrams = collectDiagrams(directory, candidateFiles(directory));
  await validateDiagramSyntax(diagrams);
  const bundled = await build({
    stdin: {
      contents: `import mermaid from "mermaid";\nmermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"neutral",fontFamily:"Arial, sans-serif",flowchart:{htmlLabels:false}});\nmermaid.run({querySelector:".mermaid"}).then(()=>{document.getElementById("state").textContent="${diagrams.length} diagrams rendered from the current architecture chapters";document.body.dataset.renderState="ready";}).catch(error=>{document.getElementById("state").textContent="Rendering failed: "+error.message;document.body.dataset.renderState="failed";});`,
      resolveDir: directory,
      sourcefile: "architecture-preview.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    logLevel: "silent",
  });
  const sections = diagrams
    .map((diagram) => {
      const title =
        readFileSync(path.join(directory, diagram.document), "utf8").match(/^# (.+)$/mu)?.[1] ??
        diagram.document;
      return `<section id="diagram-${diagrams.indexOf(diagram)}"><h2>${escapeHtml(title)}</h2><p class="source">${escapeHtml(diagram.document)} · ${diagram.sha256.slice(0, 12)}</p><pre class="mermaid">${escapeHtml(diagram.source)}</pre><details><summary>Mermaid source</summary><pre class="code">${escapeHtml(diagram.source)}</pre></details></section>`;
    })
    .join("\n");
  const script = bundled.outputFiles[0].text.replaceAll("</script", "<\\/script");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ohmyho.st architecture</title><style>body{font:16px/1.5 Arial,sans-serif;color:#18202a;background:#f8f9fb;margin:0;padding:32px}main{max-width:1600px;margin:auto}h1{font-size:32px;margin:0}h2{font-size:23px}section{margin:28px 0;padding:24px;background:white;border:1px solid #dce1e8;border-radius:12px}.source,#state{font-size:13px;color:#566371}.mermaid{overflow:auto;text-align:center;min-height:100px}.mermaid svg{height:auto;max-width:100%}.code{overflow:auto;background:#f3f5f8;padding:16px;font:13px/1.5 monospace}summary{cursor:pointer}nav{display:flex;flex-wrap:wrap;gap:14px;margin-top:18px}a{color:#1a4f91}</style></head><body data-render-state="loading"><main><h1>ohmyho.st architecture</h1><p>Current source and configuration, with implementation and pending acceptance distinguished in the canonical chapters.</p><p id="state">Rendering ${diagrams.length} diagrams locally…</p><nav>${diagrams.map((diagram, index) => `<a href="#diagram-${index}">${escapeHtml(diagram.document.replace("docs/architecture/", "").replace(".md", ""))}</a>`).join("")}</nav>${sections}</main><script>${script}</script></body></html>`;
  const destination = path.join(directory, ".ohmyhost/documentation-preview/architecture.html");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, html);
  return { path: destination, diagrams: diagrams.length, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("usage: node scripts/preview-documentation.mjs");
  process.stdout.write(`${JSON.stringify(await createArchitecturePreview())}\n`);
}
