export type PublicPreviewPhase = "starting" | "sleeping" | "unavailable" | "admission";

/** The page polls only status. Only an explicit wake action can wake a sleeping preview. */
export function statusPage(phase: PublicPreviewPhase): Response {
  const message =
    phase === "starting"
      ? "Starting your preview…"
      : phase === "sleeping"
        ? "This preview is sleeping."
        : phase === "admission"
          ? "Preview could not start. Check available credits and project access."
          : "This preview is unavailable.";
  // An accepted wake can still report sleeping or cold before its starting state is persisted.
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#faf9f6;color:#28241f}main{max-width:30rem;padding:2rem}button{border:0;border-radius:.4rem;background:#222;color:white;padding:.7rem 1rem;font:inherit;cursor:pointer}p{line-height:1.5}</style><main><h1>Preview</h1><p id="status">${message}</p><button id="wake"${phase === "sleeping" ? "" : " hidden"}>Wake preview</button></main><script>(()=>{const status=document.getElementById('status'),button=document.getElementById('wake');let active=${phase === "starting" ? "true" : "false"},checks=0,sawStarting=false;async function check(){if(!active)return;try{const r=await fetch('/__ohmyhost/preview/status',{cache:'no-store'});if(!r.ok)throw 0;const s=await r.json();if(s.state==='ready'){location.reload();return}if(s.failure){active=false;const messages={admission:'Preview could not start. Check available credits and project access.',source:'The saved source is unavailable or could not be applied.',containment:'This preview cannot start because its required isolation is unavailable.',backup:'The preview backup requires recovery before it can start.',native_preparing:'Sign-in is being prepared. Try again shortly.',startup:'The preview could not start. Try again.'};status.textContent=messages[s.failure]||messages.startup;button.hidden=false;return}if(s.state==='starting')sawStarting=true;else if(sawStarting||!['sleeping','cold'].includes(s.state)){active=false;status.textContent=s.state==='sleeping'?'This preview is sleeping.':'This preview is unavailable.';button.hidden=s.state!=='sleeping';return}}catch{active=false;status.textContent='This preview is unavailable.';return}if(++checks<240)setTimeout(check,500);else{active=false;status.textContent='This preview is taking longer than expected.'}}button.addEventListener('click',async()=>{button.disabled=true;try{const r=await fetch('/__ohmyhost/preview/wake',{method:'POST'});if(!r.ok)throw 0;button.hidden=true;status.textContent='Starting your preview…';active=true;checks=0;sawStarting=false;check()}catch{status.textContent='This preview is unavailable.'}finally{button.disabled=false}});check()})();</script></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
