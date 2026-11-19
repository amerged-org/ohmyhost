export function activeNavigation(headers) {
  return (
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document" &&
    (headers.get("sec-fetch-user") === "?1" || headers.get("sec-fetch-site") === "none")
  );
}

export function shouldExpire(lastActivity, inactivityMs, now) {
  return Number.isFinite(lastActivity) && now >= lastActivity + inactivityMs;
}

// This code runs only in public spike fixtures. Timers, HMR messages, network events and
// synthetic DOM events never renew the deadline. On wake, reload to reconnect HMR.
export const wakeScript = `<script>(()=>{let last=0,busy=false;async function active(e){if(!e.isTrusted||busy||Date.now()-last<2000)return;if(e.type==='visibilitychange'&&document.visibilityState!=='visible')return;last=Date.now();busy=true;try{const r=await fetch('/__spike/activity',{method:'POST',headers:{'x-spike-activity':'1'}});if(r.ok&&(await r.json()).woke)location.reload()}catch{}finally{busy=false}}for(const name of ['pointerdown','keydown','visibilitychange'])document.addEventListener(name,active,{passive:true})})();</script>`;
