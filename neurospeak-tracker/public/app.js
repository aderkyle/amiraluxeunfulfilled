"use strict";
const CALL=["Not called","No answer","Busy / call back","Reached","Wrong number"];
const CALL_TONE={"No answer":"warn","Busy / call back":"warn","Reached":"ok","Wrong number":"bad"};
const DEC=["Undecided","Confirmed","Will cancel","Reschedule"];
const DEC_TONE={"Confirmed":"ok","Will cancel":"bad","Reschedule":"warn"};
const STAGE=["Not processed","Processed / packed","Handed to courier","In transit","Out for delivery","Delivered","Failed attempt","Returned (RTS)"];
const STAGE_TONE={"Processed / packed":"info","Handed to courier":"info","In transit":"info","Out for delivery":"info","Delivered":"ok","Failed attempt":"warn","Returned (RTS)":"bad"};
const PAGE=60, POLL_MS=12000;
const $=s=>document.querySelector(s);
const peso=n=>"₱"+Number(n).toLocaleString("en-PH");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let base=[],added=[],track={},shown=PAGE,filtered=[],tileFilter=null,dups={};
let session={pass:"",user:""};
const pending=new Set(); // order ids with a save in flight (don't let a poll overwrite them)

/* ---------- session ---------- */
function loadSession(){try{const s=JSON.parse(localStorage.getItem("ns-tracker")||"{}");session.pass=s.pass||"";session.user=s.user||""}catch(_){}}
function keepSession(remember){try{if(remember)localStorage.setItem("ns-tracker",JSON.stringify(session));else localStorage.removeItem("ns-tracker")}catch(_){}}
async function api(path,opts={}){
  const r=await fetch("/api/"+path,{method:opts.method||"GET",headers:{"x-passcode":session.pass,"x-user":session.user,...(opts.body?{"content-type":"application/json"}:{})},body:opts.body?JSON.stringify(opts.body):undefined,cache:"no-store"});
  const data=await r.json().catch(()=>({}));
  if(r.status===401){showLogin("Your passcode was rejected. Enter the current team passcode.");throw new Error("auth")}
  if(!r.ok)throw new Error(data.error||"Something went wrong. Try again.");
  return data;
}

/* ---------- helpers ---------- */
function allOrders(){return base.concat(added)}
function t(id){return track[id]||{}}
function callOf(id){return t(id).call||"Not called"}
function decOf(id){return t(id).decision||"Undecided"}
function stageOf(id){return t(id).stage||"Not processed"}
function parseDate(s){return new Date(String(s).replace(" ","T")+"+08:00")}
function ageDays(o){return Math.max(0,Math.floor((Date.now()-parseDate(o.date))/864e5))}
function fmtDay(s,yr){return parseDate(s).toLocaleDateString("en-PH",yr?{month:"short",day:"numeric",year:"numeric"}:{month:"short",day:"numeric"})}
function rel(ts){if(!ts)return"";const m=Math.round((Date.now()-ts)/6e4);if(m<1)return"just now";if(m<60)return m+"m ago";const h=Math.round(m/60);if(h<24)return h+"h ago";return Math.round(h/24)+"d ago"}

function computeDups(){
  dups={};const by={};
  allOrders().forEach(o=>{const k=o.name.toLowerCase().replace(/\s+/g," ").trim();(by[k]=by[k]||[]).push(o)});
  Object.values(by).forEach(list=>{if(list.length<2)return;list.forEach(o=>{dups[o.id]=list.filter(x=>x!==o).map(x=>fmtDay(x.date,true))})});
}

/* ---------- pipeline ---------- */
const TILES=[
  {k:"notcalled",lbl:"Not called yet",c:"var(--muted)",test:id=>callOf(id)==="Not called"&&decOf(id)!=="Will cancel"},
  {k:"noreach",lbl:"No answer / busy",c:"var(--warn)",test:id=>["No answer","Busy / call back"].includes(callOf(id))&&decOf(id)==="Undecided"},
  {k:"confirmed",lbl:"Confirmed",c:"var(--ok)",test:id=>decOf(id)==="Confirmed"},
  {k:"cancel",lbl:"Will cancel",c:"var(--bad)",test:id=>decOf(id)==="Will cancel"},
  {k:"processed",lbl:"Processed",c:"var(--info)",test:id=>stageOf(id)==="Processed / packed"},
  {k:"moving",lbl:"With courier",c:"var(--info)",test:id=>["Handed to courier","In transit","Out for delivery"].includes(stageOf(id))},
  {k:"delivered",lbl:"Delivered",c:"var(--ok)",test:id=>stageOf(id)==="Delivered"},
  {k:"problem",lbl:"Failed / RTS",c:"var(--bad)",test:id=>["Failed attempt","Returned (RTS)"].includes(stageOf(id))},
  {k:"dupes",lbl:"Duplicates",c:"var(--bad)",test:id=>!!dups[id]},
];
function renderPipe(){
  const all=allOrders();
  $("#pipe").innerHTML=TILES.map(T=>{const hit=all.filter(o=>T.test(o.id));const amt=hit.reduce((s,o)=>s+o.price,0);
    return `<button class="tile" type="button" data-k="${T.k}" aria-pressed="${tileFilter===T.k}" style="--c:${T.c}"><span class="lbl">${T.lbl}</span><span class="val num">${hit.length}</span><span class="amt">${peso(amt)}</span></button>`}).join("");
  const total=all.reduce((s,o)=>s+o.price,0);
  const open=all.filter(o=>decOf(o.id)!=="Will cancel"&&!["Delivered","Returned (RTS)"].includes(stageOf(o.id)));
  $("#sub").innerHTML=`<span class="num">${all.length}</span> orders · <span class="num">${peso(total)}</span> COD value · <span class="num">${open.length}</span> still open (<span class="num">${peso(open.reduce((s,o)=>s+o.price,0))}</span>)`;
}
$("#pipe").addEventListener("click",e=>{const b=e.target.closest(".tile");if(!b)return;tileFilter=tileFilter===b.dataset.k?null:b.dataset.k;applyFilters()});

/* ---------- filters ---------- */
function fillSelect(el,label,opts){el.innerHTML=`<option value="">${label}</option>`+opts.map(o=>`<option value="${esc(o[0])}">${esc(o[1])}</option>`).join("")}
function setupFilters(){fillSelect($("#fCall"),"Any call status",CALL.map(x=>[x,x]));fillSelect($("#fDec"),"Any decision",DEC.map(x=>[x,x]));fillSelect($("#fStage"),"Any delivery stage",STAGE.map(x=>[x,x]));refreshDates()}
function refreshDates(){
  const cur=$("#fDate").value;const m={};
  allOrders().forEach(o=>{const d=o.date.slice(0,10);m[d]=(m[d]||0)+1});
  fillSelect($("#fDate"),"Any order date",Object.keys(m).sort().reverse().map(d=>[d,new Date(d+"T00:00:00+08:00").toLocaleDateString("en-PH",{month:"short",day:"numeric",weekday:"short"})+` (${m[d]})`]));
  $("#fDate").value=cur;
}
["#q","#fCall","#fDec","#fStage","#fDate","#sort"].forEach(s=>$(s).addEventListener("input",()=>applyFilters()));
function applyFilters(){
  computeDups();
  const q=$("#q").value.trim().toLowerCase(),qd=q.replace(/\D/g,"");
  const fc=$("#fCall").value,fd=$("#fDec").value,fs=$("#fStage").value,fdt=$("#fDate").value;
  const T=TILES.find(x=>x.k===tileFilter);
  filtered=allOrders().filter(o=>{
    if(q&&!(o.name.toLowerCase().includes(q)||(qd.length>=3&&o.phone.includes(qd))))return false;
    if(fc&&callOf(o.id)!==fc)return false;
    if(fd&&decOf(o.id)!==fd)return false;
    if(fs&&stageOf(o.id)!==fs)return false;
    if(fdt&&o.date.slice(0,10)!==fdt)return false;
    if(T&&!T.test(o.id))return false;
    return true});
  const s=$("#sort").value;
  filtered.sort(s==="new"?(a,b)=>b.date.localeCompare(a.date):s==="price"?(a,b)=>b.price-a.price||a.date.localeCompare(b.date):s==="upd"?(a,b)=>(t(b.id).at||0)-(t(a.id).at||0):(a,b)=>a.date.localeCompare(b.date));
  shown=PAGE;renderPipe();renderRows();
}

/* ---------- rows ---------- */
function opts(list){return list.map(x=>`<option>${esc(x)}</option>`).join("")}
function rowHTML(o){
  const a=ageDays(o),ac=a>=21?"a3":a>=7?"a2":"a1";
  const srcLbl=o.src==="A"?"Added":o.src==="N"?"New":"Waybill";
  const dupTag=(dups[o.id]||[]).map(d=>`<span class="dup">Duplicate on ${esc(d)}</span>`).join("");
  return `<div class="row" data-id="${o.id}">
  <div class="cust"><div class="nm">${esc(o.name)}<span class="src ${o.src}">${srcLbl}</span>${dupTag}</div>
    <div class="ph"><span class="num">${esc(o.phone)}</span><button class="copy" type="button" data-copy="${esc(o.phone)}">Copy</button><a class="call" href="tel:${esc(o.phone)}">Call</a></div></div>
  <div class="when"><div class="cap">Ordered</div><span class="num">${fmtDay(o.date)}</span><br><span class="age ${ac} num">${a}d old</span></div>
  <div class="price num"><div class="cap">Price</div>${peso(o.price)}</div>
  <div><div class="cap">Call</div><div class="callcell"><select data-f="call" aria-label="Call status">${opts(CALL)}</select><button class="plus" type="button" data-act="attempt" title="Log another call attempt">+1</button></div><div class="attempts num"></div></div>
  <div><div class="cap">Decision</div><select data-f="decision" aria-label="Customer decision">${opts(DEC)}</select></div>
  <div><div class="cap">Delivery stage</div><select data-f="stage" aria-label="Delivery stage">${opts(STAGE)}</select></div>
  <div><div class="cap">Tracking no.</div><input data-f="tracking" class="num" placeholder="Waybill / tracking" aria-label="Tracking number" maxlength="60"></div>
  <div><div class="cap">Notes</div><input data-f="notes" placeholder="Add note" aria-label="Notes" maxlength="500"></div>
  <div class="upd"></div></div>`;
}
function paintRow(el){
  const id=el.dataset.id,e=t(id);
  const vals={call:callOf(id),decision:decOf(id),stage:stageOf(id),tracking:e.tracking||"",notes:e.notes||""};
  el.querySelectorAll("[data-f]").forEach(c=>{
    if(document.activeElement===c)return;
    const v=vals[c.dataset.f];if(c.value!==v)c.value=v;
    if(c.tagName==="SELECT"){const tone=(c.dataset.f==="call"?CALL_TONE:c.dataset.f==="decision"?DEC_TONE:STAGE_TONE)[v];if(tone)c.dataset.tone=tone;else delete c.dataset.tone}
  });
  el.querySelector(".attempts").textContent=e.attempts?`${e.attempts} call attempt${e.attempts>1?"s":""}${e.lastCall?" · last "+rel(e.lastCall):""}`:"";
  el.classList.toggle("cancelled",vals.decision==="Will cancel");
  const u=el.querySelector(".upd");
  if(e.at){u.textContent="";const w=document.createElement("span");w.textContent=e.by||"Team";u.append(w,document.createElement("br"),rel(e.at))}else u.textContent="—";
}
function renderRows(){
  const box=$("#rows");
  $("#count").textContent=`${filtered.length} of ${allOrders().length} shown`;
  if(!filtered.length){box.innerHTML=`<div class="empty">No orders match these filters.</div>`;return}
  box.innerHTML=filtered.slice(0,shown).map(rowHTML).join("")+(filtered.length>shown?`<div class="more"><button type="button" id="moreBtn">Show ${Math.min(PAGE,filtered.length-shown)} more (${filtered.length-shown} left)</button></div>`:"");
  box.querySelectorAll(".row").forEach(paintRow);
}
function repaintVisible(){document.querySelectorAll("#rows .row").forEach(paintRow);renderPipe()}

$("#rows").addEventListener("click",e=>{
  if(e.target.id==="moreBtn"){shown+=PAGE;renderRows();return}
  const cp=e.target.closest("[data-copy]");
  if(cp){const v=cp.dataset.copy;const fb=()=>selectText(cp.previousElementSibling);try{navigator.clipboard.writeText(v).then(()=>toast("Copied "+v),fb)}catch(_){fb()}return}
  const at=e.target.closest("[data-act=attempt]");
  if(at)save(at.closest(".row").dataset.id,{attempt:true});
});
function selectText(el){const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);toast("Number selected. Copy it.")}
$("#rows").addEventListener("change",e=>{
  const c=e.target.closest("[data-f]");if(!c)return;
  save(c.closest(".row").dataset.id,{[c.dataset.f]:c.value.trim()});
});

/* ---------- saving ---------- */
const chains={};
function save(id,patch){
  // optimistic local update so the screen responds immediately
  const e=Object.assign({},t(id));
  ["call","decision","stage","tracking","notes"].forEach(k=>{if(patch[k]!==undefined)e[k]=patch[k]});
  if(patch.attempt){e.attempts=(e.attempts||0)+1;e.lastCall=Date.now();if(!e.call||e.call==="Not called")e.call="No answer"}
  else if(patch.call&&patch.call!=="Not called"&&!e.attempts){e.attempts=1;e.lastCall=Date.now()}
  if(patch.stage&&patch.stage!=="Not processed"&&(!e.decision||e.decision==="Undecided"))e.decision="Confirmed";
  e.by=session.user;e.at=Date.now();track[id]=e;pending.add(id);repaintVisible();setSync("Saving…");
  chains[id]=(chains[id]||Promise.resolve()).then(async()=>{
    try{const r=await api("track",{method:"POST",body:{id,patch}});track[id]=r.entry;setSync("Saved")}
    catch(err){if(err.message!=="auth"){toast(err.message);setSync("Not saved",true)}}
    finally{pending.delete(id);repaintVisible()}
  });
}

/* ---------- sync ---------- */
let pollT=null,lastSync=0;
function setSync(txt,bad){const el=$("#sync");el.textContent=txt;el.classList.toggle("bad",!!bad)}
async function pull(full){
  try{
    const s=await api("state");
    const keep={};pending.forEach(id=>keep[id]=track[id]);
    track=Object.assign(s.track||{},keep);
    const newAdded=(s.added||[]).map(a=>({id:a.id,name:a.name,phone:a.phone,src:"A",date:a.date,price:+a.price||0}));
    const addedChanged=newAdded.length!==added.length;
    added=newAdded;lastSync=Date.now();setSync("Synced just now");
    if(full||addedChanged){refreshDates();applyFilters()}else repaintVisible();
  }catch(err){if(err.message!=="auth")setSync("Offline. Retrying…",true)}
}
function startPolling(){stopPolling();pollT=setInterval(()=>{if(!document.hidden)pull(false)},POLL_MS)}
function stopPolling(){if(pollT)clearInterval(pollT);pollT=null}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&pollT)pull(false)});
setInterval(()=>{if(lastSync&&!$("#sync").classList.contains("bad")&&$("#sync").textContent!=="Saving…")setSync("Synced "+rel(lastSync))},30000);

/* ---------- add order ---------- */
$("#addBtn").addEventListener("click",()=>{
  const now=new Date(Date.now()+8*3600e3).toISOString().slice(0,16);
  $("#dlgRoot").innerHTML=`<div class="dlg-bg"><form class="dlg" id="addForm"><h2>Add order</h2>
  <label for="aName">Customer name<input id="aName" required maxlength="80"></label>
  <label for="aPhone">Mobile number<input id="aPhone" class="num" inputmode="numeric" placeholder="09XXXXXXXXX" required></label>
  <label for="aPrice">Price (₱)<select id="aPrice"><option>499</option><option selected>699</option><option>999</option><option>399</option><option>599</option></select></label>
  <label for="aDate">Order date and time<input id="aDate" type="datetime-local" value="${now}" required></label>
  <div class="err" id="aErr" role="alert"></div>
  <div class="btns"><button type="button" id="aCancel">Cancel</button><button class="primary" type="submit">Add order</button></div></form></div>`;
  $("#aName").focus();
  $("#aCancel").onclick=()=>$("#dlgRoot").innerHTML="";
  $("#addForm").onsubmit=async ev=>{ev.preventDefault();
    try{const r=await api("orders",{method:"POST",body:{name:$("#aName").value,phone:$("#aPhone").value,price:+$("#aPrice").value,date:$("#aDate").value.replace("T"," ")+":00"}});
      const a=r.order;added.push({id:a.id,name:a.name,phone:a.phone,src:"A",date:a.date,price:a.price});
      $("#dlgRoot").innerHTML="";refreshDates();applyFilters();toast("Order added")}
    catch(err){if(err.message!=="auth")$("#aErr").textContent=err.message}
  };
});

/* ---------- export ---------- */
$("#exportBtn").addEventListener("click",()=>{
  const head=["Customer Name","Contact Number","Order Date","Price","Original Status","Duplicate Of","Call Status","Call Attempts","Decision","Delivery Stage","Tracking No.","Notes","Last Updated By","Last Updated"];
  const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const lines=[head.map(q).join(",")].concat(filtered.map(o=>{const e=t(o.id);return[o.name,o.phone,o.date,o.price,o.src==="W"?"Pending printed waybill":o.src==="N"?"New":"Added in tracker",(dups[o.id]||[]).map(d=>"Duplicate on "+d).join("; "),callOf(o.id),e.attempts||0,decOf(o.id),stageOf(o.id),e.tracking||"",e.notes||"",e.by||"",e.at?new Date(e.at).toLocaleString("en-PH"):""].map(q).join(",")}));
  const blob=new Blob(["﻿"+lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`neurospeak-orders-${new Date().toISOString().slice(0,10)}.csv`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500);
});

let toastT;function toast(m){let el=$(".toast");if(!el){el=document.createElement("div");el.className="toast";el.setAttribute("role","status");document.body.appendChild(el)}el.textContent=m;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>el.hidden=true,2400)}

/* ---------- login ---------- */
function showLogin(msg){
  stopPolling();$("#app").hidden=true;$("#login").hidden=false;
  $("#lErr").textContent=msg||"";$("#lUser").value=session.user||"";$("#lPass").value="";
  (session.user?$("#lPass"):$("#lUser")).focus();
}
$("#loginForm").addEventListener("submit",async ev=>{
  ev.preventDefault();
  session.user=$("#lUser").value.trim().slice(0,60);session.pass=$("#lPass").value;
  if(!session.user){$("#lErr").textContent="Enter your name so the team can see who updated each order.";return}
  $("#lBtn").disabled=true;$("#lErr").textContent="";
  try{await api("check");keepSession($("#lRemember").checked);await enter()}
  catch(err){if(err.message!=="auth")$("#lErr").textContent="Couldn't reach the tracker. Check your connection and try again."}
  finally{$("#lBtn").disabled=false}
});
$("#signOut").addEventListener("click",()=>{session.pass="";keepSession(false);showLogin("Signed out.")});

async function enter(){
  $("#login").hidden=true;$("#app").hidden=false;$("#who").textContent=session.user;
  if(!base.length){const r=await api("orders");base=r.orders.map(a=>({id:a[0],name:a[1],phone:a[2],src:a[3],date:a[4],price:a[5]}))}
  await pull(true);startPolling();
}

/* ---------- boot ---------- */
setupFilters();loadSession();
if(session.pass&&session.user){enter().catch(err=>{if(err.message!=="auth")showLogin("Couldn't reach the tracker. Sign in again.")})}
else showLogin("");
