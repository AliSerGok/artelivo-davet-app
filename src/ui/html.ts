// Küçük HTML yardımcıları — sunucu tarafında üretilen sayfalar.

export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch,
  );
}

/** Şablon etiketi: `${}` içindekiler kaçışlanır; `raw()` ile sarılanlar olduğu gibi. */
export class Raw {
  constructor(readonly value: string) {}
}
export const raw = (value: string) => new Raw(value);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Raw) out += v.value;
      else if (Array.isArray(v))
        out += v.map((x) => (x instanceof Raw ? x.value : esc(x))).join("");
      else if (v === null || v === undefined || v === false) out += "";
      else out += esc(v);
    }
  });
  return new Raw(out);
}

// ─── Bileşenler ─────────────────────────────────────────────────────────────

export type Tone = "neutral" | "info" | "progress" | "ok" | "warn" | "bad";

/** Durum rozeti. `progress` dönen bir nokta taşır: süren bir iş. */
export function badge(text: string, tone: Tone = "neutral"): Raw {
  return html`<span class="badge ${tone}">${tone === "progress" ? raw('<i class="spin"></i>') : ""}${text}</span>`;
}

/** Sayfa başlığı: başlık, bir satır açıklama, sağda düğmeler. */
export function pageHeader(title: string, subtitle: string | Raw, actions?: Raw): Raw {
  return html`<div class="ph">
    <div><h1>${title}</h1><p class="sub">${subtitle}</p></div>
    ${actions ? html`<div class="ph-actions">${actions}</div>` : ""}
  </div>`;
}

export function emptyState(title: string, hint: string | Raw): Raw {
  return html`<div class="empty"><b>${title}</b><span>${hint}</span></div>`;
}

export function progressBar(done: number, total: number): Raw {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return html`<div class="bar"><span style="width:${pct}%"></span></div>`;
}

/** Adım çubuğu: `current` tamamlanan son adımın sırası; `active` sürüyor; `failed` o adımda hata. */
export function steps(
  labels: string[],
  current: number,
  state: "idle" | "active" | "failed" = "idle",
): Raw {
  return html`<ol class="steps">
    ${labels.map((label, i) => {
      const cls =
        i <= current ? "done" : i === current + 1 && state !== "idle" ? state : "";
      return html`<li class="${cls}" title="${label}"><span></span><em>${label}</em></li>`;
    })}
  </ol>`;
}

// ─── Sayfa iskeleti ─────────────────────────────────────────────────────────

const NAV = [
  ["/", "Turlar", "runs", "M3 5h18M3 12h18M3 19h12"],
  ["/artists", "Sanatçılar", "artists", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0"],
  ["/messages", "Mesajlar", "messages", "M4 5h16v11H8l-4 4V5Z"],
  ["/outcomes", "Davet sonuçları", "", "M5 12l4 4L19 6"],
  ["/jobs", "İşler", "jobs", "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z"],
  ["/settings", "Ayarlar", "", "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4"],
] as const;

const CSS = `
:root{--bg:#f6f4f1;--panel:#fff;--fg:#1c1917;--muted:#78716c;--faint:#a8a29e;--line:#e7e2dc;--hover:#f2eee9;
--accent:#9f1d20;--accent-fg:#fff;--ok:#15803d;--ok-bg:#ecfdf3;--warn:#b45309;--warn-bg:#fff7e6;--bad:#b91c1c;--bad-bg:#fef2f2;
--info:#1d4ed8;--info-bg:#eff4ff;--prog:#7c3aed;--prog-bg:#f5f0ff;--neutral-bg:#f2eee9;--shadow:0 1px 2px rgba(28,25,23,.06),0 4px 16px rgba(28,25,23,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0f0d0c;--panel:#1a1716;--fg:#f5f5f4;--muted:#a8a29e;--faint:#78716c;--line:#2c2724;--hover:#24201e;
--accent:#e0484c;--accent-fg:#fff;--ok:#4ade80;--ok-bg:#0f2a1a;--warn:#fbbf24;--warn-bg:#2a2010;--bad:#f87171;--bad-bg:#2c1414;
--info:#93b4ff;--info-bg:#152040;--prog:#c4a5ff;--prog-bg:#24183d;--neutral-bg:#24201e;--shadow:none}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}code{font:12px ui-monospace,Menlo,monospace;background:var(--neutral-bg);padding:1px 5px;border-radius:5px}
.app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;padding:20px 14px;border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;gap:4px}
.brand{font:600 19px Georgia,"Times New Roman",serif;padding:2px 10px 18px;letter-spacing:.2px}.brand small{display:block;font:12px -apple-system,system-ui,sans-serif;color:var(--muted);margin-top:2px}
.nav{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;text-decoration:none;color:var(--muted);font-weight:500}
.nav svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.nav:hover{background:var(--hover);color:var(--fg)}.nav.on{background:var(--neutral-bg);color:var(--fg)}
.nav .count{margin-left:auto;font-size:11px;font-weight:600;min-width:20px;text-align:center;padding:1px 6px;border-radius:999px;background:var(--accent);color:var(--accent-fg)}
.nav .count:empty{display:none}
.aside-foot{margin-top:auto;font-size:12px;color:var(--faint);padding:0 10px}
.content{min-width:0}
.activity{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:12px 28px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.act-main{display:flex;align-items:center;gap:12px;min-width:0;flex:1}
.act-icon{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--neutral-bg)}
.act-icon .spin{width:14px;height:14px}
.activity.busy .act-icon{background:var(--prog-bg)}.activity.paused .act-icon{background:var(--warn-bg)}
.act-text{min-width:0}.act-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.act-detail{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.act-meta{display:flex;gap:8px;flex:none;font-size:12px;color:var(--muted)}.act-meta span{padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel)}
main{max-width:1180px;margin:0 auto;padding:26px 28px 80px}
.ph{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px}
h1{font:600 26px/1.2 Georgia,"Times New Roman",serif;margin:0}.sub{margin:4px 0 0;color:var(--muted)}.ph-actions{display:flex;gap:8px;flex-wrap:wrap}
h2{font-size:15px;margin:0 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:var(--shadow)}
.card.flush{padding:0}.card.flush>:first-child{border-radius:14px 14px 0 0}.card.flush>:last-child{border-radius:0 0 14px 14px}
.callout{display:flex;gap:10px;align-items:flex-start;border-radius:12px;padding:12px 14px;margin-bottom:16px;border:1px solid}
.callout.warn{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}.callout.bad{background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.callout.info{background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 25%,transparent)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:500;font-size:12px;background:var(--panel)}tr:last-child td{border-bottom:0}tbody tr:hover td{background:var(--hover)}
td .muted,.muted{color:var(--muted)}.small{font-size:12px}.nowrap{white-space:nowrap}
.btn,button{appearance:none;display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;border-radius:9px;padding:8px 14px;font:600 13px -apple-system,system-ui,sans-serif;cursor:pointer;text-decoration:none;transition:background .15s,opacity .15s,transform .05s;white-space:nowrap}
.btn:active,button:active{transform:translateY(1px)}
.primary{background:var(--accent);color:var(--accent-fg)}.primary:hover{filter:brightness(1.07)}
.secondary{background:var(--panel);color:var(--fg);border-color:var(--line)}.secondary:hover{background:var(--hover)}
.subtle{background:transparent;color:var(--muted);padding:6px 9px}.subtle:hover{background:var(--hover);color:var(--fg)}
.danger{background:transparent;color:var(--bad);padding:6px 9px}.danger:hover,.danger.armed{background:var(--bad-bg)}
button:disabled,.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;transform:none}
button.loading{opacity:.85;cursor:progress}
input,select,textarea{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
input:focus,select:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--accent) 35%,transparent);border-color:var(--accent)}
textarea{width:100%;min-height:170px;line-height:1.55}input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);padding:0}
.field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:500}.field input,.field select{font-size:14px;color:var(--fg)}
.form-grid{display:grid;grid-template-columns:2fr 1fr 1.4fr 1.4fr auto;gap:12px;align-items:end}
.range{display:flex;align-items:center;gap:6px}.range input{width:72px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.inline{display:inline}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap}
.badge.neutral{background:var(--neutral-bg);color:var(--muted)}.badge.info{background:var(--info-bg);color:var(--info)}.badge.progress{background:var(--prog-bg);color:var(--prog)}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}
.spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:r .7s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
.bar{height:6px;border-radius:99px;background:var(--neutral-bg);overflow:hidden;min-width:90px}.bar span{display:block;height:100%;background:var(--accent);border-radius:99px;transition:width .4s}
.steps{display:flex;list-style:none;margin:0;padding:0;gap:4px}
.steps li{display:flex;flex-direction:column;align-items:center;gap:3px;width:62px}.steps li span{width:100%;height:5px;border-radius:99px;background:var(--neutral-bg)}
.steps li em{font-style:normal;font-size:10px;color:var(--faint);white-space:nowrap}
.steps li.done span{background:var(--ok)}.steps li.done em{color:var(--muted)}
.steps li.active span{background:linear-gradient(90deg,var(--prog) 40%,var(--prog-bg) 40%);background-size:200% 100%;animation:slide 1.1s linear infinite}.steps li.active em{color:var(--prog)}
.steps li.failed span{background:var(--bad)}.steps li.failed em{color:var(--bad)}
@keyframes slide{from{background-position:100% 0}to{background-position:-100% 0}}
.selbar{position:sticky;top:57px;border-radius:14px 14px 0 0;z-index:10;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.selbar .selcount{font-weight:600;margin-right:6px}.selbar .selcount.zero{color:var(--muted);font-weight:500}
.person b{display:block}.person .muted{font-size:12px}
.audit{margin-top:6px;font-size:12px}.audit summary{cursor:pointer;font-weight:600;list-style:none}.audit summary::-webkit-details-marker{display:none}
.audit summary.ok{color:var(--ok)}.audit summary.warn{color:var(--warn)}.audit summary.bad{color:var(--bad)}
.audit ul{list-style:none;margin:6px 0 0;padding:8px 10px;background:var(--neutral-bg);border-radius:8px;display:grid;gap:3px;min-width:320px}
.links summary{color:var(--muted)}.links ul{gap:6px;padding:10px 12px}
.links li{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:baseline}
.links li b{color:var(--muted);font-weight:600}.links li div{min-width:0}
.links li a{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.links li small{display:block;color:var(--faint);font-size:11px}
.links li.foot{display:block;margin-top:4px;padding-top:6px;border-top:1px solid var(--line);color:var(--muted)}
.audit li span{color:var(--muted)}.audit .a-ok b{color:var(--ok)}.audit .a-warn b{color:var(--warn)}.audit .a-bad b{color:var(--bad)}.audit .a-none b{color:var(--faint)}
.tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin:0 0 12px}
.tab{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;text-decoration:none;color:var(--muted);font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--fg)}.tab.on{color:var(--fg);border-bottom-color:var(--accent)}
.tab span{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--neutral-bg);color:var(--muted)}.tab.on span{background:var(--accent);color:var(--accent-fg)}
.tab-hint{margin:-4px 0 12px}
.note{font-size:12px;margin-top:5px}.note.bad{color:var(--bad)}.note.warn{color:var(--warn)}
.empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:44px 20px;text-align:center;color:var(--muted)}.empty b{color:var(--fg);font-size:15px}
.msg{display:grid;gap:10px}.msg-head{display:flex;align-items:center;gap:10px;justify-content:space-between}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat b{display:block;font-size:22px;font-family:Georgia,serif}.stat span{font-size:12px;color:var(--muted)}
.checks{list-style:none;margin:0;padding:0;display:grid;gap:8px}.checks li{display:flex;gap:10px;align-items:center}
#toasts{position:fixed;right:20px;bottom:20px;z-index:50;display:flex;flex-direction:column;gap:10px;max-width:380px}
.toast{display:flex;gap:10px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--muted);border-radius:12px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.14);animation:pop .2s ease-out}
.toast.ok{border-left-color:var(--ok)}.toast.bad{border-left-color:var(--bad)}.toast.warn{border-left-color:var(--warn)}.toast.info{border-left-color:var(--info)}
.toast b{display:block}.toast span{font-size:13px;color:var(--muted)}.toast button{margin-left:auto;padding:0 4px;background:none;color:var(--faint);font-size:16px}
@keyframes pop{from{transform:translateY(8px);opacity:0}}
@media (max-width:900px){.app{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}.brand{padding-bottom:0}.aside-foot{display:none}.form-grid{grid-template-columns:1fr 1fr}.activity{padding:10px 16px}main{padding:20px 16px 60px}}
`;

const SCRIPT = `
var version=null,refreshing=false,lastEvent=null;
function $(s,r){return (r||document).querySelector(s)}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function esc(t){var d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML}
function toast(title,text,tone,ms){var box=$('#toasts');var el=document.createElement('div');el.className='toast '+(tone||'info');
el.innerHTML='<div><b>'+esc(title)+'</b>'+(text?'<span>'+esc(text)+'</span>':'')+'</div><button aria-label="Kapat">×</button>';
el.querySelector('button').onclick=function(){el.remove()};box.appendChild(el);setTimeout(function(){el.remove()},ms||(tone==='bad'?14000:6000));}
// Sunucunun yönlendirmeden önce bıraktığı mesaj (düğmenin sonucu).
(function(){var m=document.cookie.match(/(?:^|; )davet_flash=([^;]*)/);if(!m)return;document.cookie='davet_flash=; Max-Age=0; Path=/';
try{var f=JSON.parse(decodeURIComponent(m[1]));toast(f.title,f.text,f.tone)}catch(e){}})();
function busyEditing(){var a=document.activeElement;if(a&&a.matches&&a.matches('main input:not([type=checkbox]),main textarea,main select'))return true;
if($$('main textarea,main input[type=text],main input[type=number],main input:not([type])').some(function(x){return x.value!==x.defaultValue}))return true;
// Açılır kutu: odak gitse de seçim değiştiyse yenileme beklesin (yoksa seçim varsayılana döner).
return $$('main select').some(function(x){var d=Array.prototype.findIndex.call(x.options,function(o){return o.defaultSelected});return x.selectedIndex!==(d<0?0:d)});}
async function refresh(){if(refreshing||busyEditing()||$('button.loading,button.armed'))return false;refreshing=true;try{
var r=await fetch(location.href);if(!r.ok||r.redirected)return false;
var doc=new DOMParser().parseFromString(await r.text(),'text/html');var next=doc.querySelector('main');if(!next)return false;
var checked={};$$('main input[type=checkbox]:checked').forEach(function(x){checked[x.name+'='+x.value]=1});
var opened={};$$('main details[open][data-key]').forEach(function(x){opened[x.dataset.key]=1});
var y=window.scrollY;$('main').replaceWith(next);
$$('main details[data-key]').forEach(function(x){if(opened[x.dataset.key])x.open=true});
$$('main input[type=checkbox]').forEach(function(x){if(checked[x.name+'='+x.value])x.checked=true});
updateSelection();window.scrollTo(0,y);return true;}catch(e){return false}finally{refreshing=false}}
function fmtElapsed(since){if(!since)return '';var t=Date.parse(since.replace(' ','T')+'Z');if(isNaN(t))return '';var s=Math.max(0,Math.round((Date.now()-t)/1000));
return s<60?s+' sn':Math.floor(s/60)+' dk '+(s%60)+' sn'}
function fmtClock(utc){var t=Date.parse(String(utc).replace(' ','T')+'Z');if(isNaN(t))return '';var d=new Date(t);var same=d.toDateString()===new Date().toDateString();
return (same?'':d.toLocaleDateString('tr-TR',{day:'numeric',month:'short'})+' ')+d.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}
var current=null;
function paintActivity(s){var a=$('#activity');a.className='activity'+(s.paused?' paused':s.current?' busy':'');
var icon=s.paused?'⏸':s.current?'<i class="spin" style="color:var(--prog)"></i>':'✓';
$('.act-icon',a).innerHTML=icon;current=s.current;
$('.act-title',a).textContent=s.paused?'Kuyruk durduruldu':s.current?s.current.title:'Boşta';
$('.act-detail',a).textContent=s.paused?'Sıradaki işler bekliyor — İşler sayfasından sürdür.':s.current?(s.current.detail||''):(s.queued?s.queued+' iş sırada'+(s.nextAt?' · sıradaki '+fmtClock(s.nextAt):''):'Sırada iş yok');
var meta=[];if(s.current&&s.queued)meta.push(s.queued+' iş sırada');meta.push('Bugün '+s.dmToday+'/'+s.dmLimit+' DM');if(s.review)meta.push('Onay penceresi açık');
$('.act-meta',a).innerHTML=meta.map(function(m){return '<span>'+esc(m)+'</span>'}).join('');
for(var k in s.counts){var el=$('[data-count="'+k+'"]');if(el)el.textContent=s.counts[k]||''}}
setInterval(function(){if(current&&current.since){var d=$('.act-detail');if(d)d.textContent=(current.detail?current.detail+' · ':'')+fmtElapsed(current.since)}},1000);
async function poll(){try{var r=await fetch('/api/status'+(lastEvent!==null?'?since='+lastEvent:''));var s=await r.json();paintActivity(s);
(s.events||[]).forEach(function(e){toast(e.title,e.text,e.tone)});lastEvent=s.lastEvent;
if(version!==null&&s.version!==version){if(await refresh())version=s.version}else version=s.version}catch(e){}}
poll();setInterval(poll,3000);
// Düğmeye basıldı: dönen işaret + form kilitlenir; sonuç sonraki sayfada bildirim olarak gelir.
document.addEventListener('submit',function(e){if(e.defaultPrevented)return;var f=e.target,b=e.submitter;
if(b){b.classList.add('loading');b.innerHTML='<i class="spin"></i>'+esc(b.dataset.busy||b.textContent.trim())}
// form="…" ile dışarıdan bağlı düğmeler de: form.elements hepsini kapsar.
setTimeout(function(){Array.prototype.forEach.call(f.elements,function(x){if(x.tagName==='BUTTON')x.disabled=true});if(b)b.disabled=true},0)});
// Silme gibi düğmeler iki basışla onaylanır: arayüz Playwright'ın Chrome'unda
// açıldığından confirm() kendiliğinden "hayır" döner (diyalog kapatılır).
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-confirm]');if(!b||b.dataset.armed)return;
e.preventDefault();b.dataset.armed='1';var old=b.innerHTML;b.textContent='Emin misin? Tekrar bas';b.classList.add('armed');
toast('Onay gerekiyor',b.dataset.confirm,'warn',4000);
setTimeout(function(){if(!b.classList.contains('loading')){delete b.dataset.armed;b.classList.remove('armed');b.innerHTML=old}},4000)},true);
window.addEventListener('pageshow',function(e){if(e.persisted)location.reload()});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[target="_blank"]');if(!a)return;e.preventDefault();
var f=new FormData();f.append('url',a.href);fetch('/open-external',{method:'POST',body:f});toast('Ana tarayıcında açıldı',a.textContent.trim(),'info',2500)});
function updateSelection(){var n=$$('main input[name="ids"]:checked').length;$$('[data-selcount]').forEach(function(el){el.textContent=n?n+' seçili':'Seçim yok';el.classList.toggle('zero',!n)});
$$('[data-needs-selection]').forEach(function(b){b.disabled=!n})}
document.addEventListener('change',function(e){var t=e.target;if(t.matches&&t.matches('[data-check-all]'))$$('main input[name="ids"]:not(:disabled)').forEach(function(x){x.checked=t.checked});updateSelection()});
updateSelection();
`;

export function page(title: string, active: string, body: Raw): string {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Artelivo Davet</title><link rel="icon" href="data:,">
<style>${CSS}</style></head><body>
<div class="app">
<aside>
  <div class="brand">Artelivo Davet<small>Davet masası</small></div>
  ${NAV.map(([href, label, key, icon]) => `<a href="${href}" class="nav${active === href ? " on" : ""}"><svg viewBox="0 0 24 24"><path d="${icon}"/></svg>${label}${key ? `<span class="count" data-count="${key}"></span>` : ""}</a>`).join("")}
  <div class="aside-foot">Yerel uygulama · 127.0.0.1</div>
</aside>
<div class="content">
  <div id="activity" class="activity"><div class="act-main"><div class="act-icon"></div><div class="act-text"><div class="act-title">…</div><div class="act-detail"></div></div></div><div class="act-meta"></div></div>
  <main>${body.value}</main>
</div>
</div>
<div id="toasts" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body></html>`;
}
