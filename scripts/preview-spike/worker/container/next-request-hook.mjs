import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

const MARKER = "\n;/* preview-spike-next-origin-hook */";

// Only the disposable, copy-installed pinned Next graph is changed. Do not mutate the
// shared package store: fail if the resolved runtime is outside this fixture workspace.
export async function installNextRequestOrigin(workspace, origin) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw new Error("preview_origin_invalid");
  const root = await realpath(workspace);
  const server = await realpath(path.join(root, "node_modules/next/dist/server/next-server.js"));
  const relative = path.relative(root, server);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await stat(server)).isFile()
  )
    throw new Error("preview_next_runtime_invalid");
  const installed = await readFile(server, "utf8");
  const pieces = installed.split(MARKER);
  if (pieces.length > 2 || !pieces[0].includes("attachRequestMeta"))
    throw new Error("preview_next_request_contract_changed");
  // Next builds request.url from the local listening address. Preserve its request metadata,
  // but use the signed public origin so the fixture's same-origin checks see the browser URL.
  const patch = `${MARKER}{const prototype=module.exports.default?.prototype;const original=prototype?.attachRequestMeta;if(typeof original!=='function')throw new Error('preview_next_request_contract_changed');const origin=${JSON.stringify(origin)};prototype.attachRequestMeta=function(request,...args){const result=Reflect.apply(original,this,[request,...args]);const metadata=request[Symbol.for('NextInternalRequestMeta')];if(!metadata||typeof metadata.initURL!=='string'||typeof request.url!=='string')throw new Error('preview_next_request_contract_changed');const url=new URL(request.url,origin);const canonical=new URL(origin);url.protocol=canonical.protocol;url.host=canonical.host;url.port=canonical.port;metadata.initURL=url.href;metadata.initProtocol=canonical.protocol.slice(0,-1);return result;};}\n`;
  await writeFile(server, `${pieces[0]}${patch}`);
}
