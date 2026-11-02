// Financial tab money math, for the server (the monthly summary email).
//
// The block between the markers below is COPIED VERBATIM from index.html (the
// Financial tab's calc functions: finSuggest .. finFlagsFor) so the email's
// numbers are exactly the numbers the tab shows. If you change the calc in
// index.html, re-copy that block here (same functions, same order) — the
// copy was checked for parity against the browser on identical data.
//
// No prices or rates live here: they come in as `settings` (Cosmos
// finance:settings) at call time.
function createFinanceCalc(settings, items) {
  const fin = { settings: settings || {}, items: items || [] };
  function finIso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  const finMoney=v=> v==null||!isFinite(v)? '—' : (v<0?'−':'')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});
  const finNum=v=> v==null||!isFinite(v)? '—' : (Math.round(v*10)/10).toLocaleString('en-US');
  function jsEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  // ---- BEGIN COPY FROM index.html ----
function finSuggest(text){
  // Commas stay (they end a phrase); location numbers ("floor 8", "floors 7 and 8",
  // "Day 1", "L2") are blanked first so they're never read as quantities.
  let t=' '+String(text||'').toLowerCase().replace(/~/g,' ')+' ';
  t=t.replace(/\b(?:floors?|levels?|lvl|day|days|rooms?|rm|suite|ste|bldg|building|l)\s*\d+(?:\s*(?:,|and|&|-)\s*\d+)*/g,m=>' '.repeat(m.length));
  const units={}; let hits=0;
  // Verb first: "reconnected about 60 systems", "decommissioned around 30".
  const ABOUT='(?:about|around|approx\\.?|approximately|roughly|over|~)?\\s*';
  // Past tense only: "set up 15 decom" must stay "…set up" + "15 decom", not "set up 15".
  [['reconnect',new RegExp('\\breconnected\\s+'+ABOUT+'(\\d+)','g')],
   ['partial',new RegExp('\\b(?:disconnected|decommissioned)\\s+'+ABOUT+'(\\d+)','g')],
   ['unbox',new RegExp('\\bunboxed\\s+'+ABOUT+'(\\d+)','g')]].forEach(([key,re])=>{
    t=t.replace(re,(m,n)=>{ units[key]=(units[key]||0)+(+n); hits++; return ' '.repeat(m.length); });
  });
  const W='(?:[a-z/&+-]+\\s+){0,3}?'; // up to 3 WORDS between the count and the item ("150 stations set up"), never another number
  const rules=[
    ['dr',     new RegExp('(\\d+)\\+?\\s+'+W+'(?:disconnects?\\s*(?:and|&|/)\\s*reconnects?|disconnect/reconnects?|d\\s*/\\s*r\\b)','g')],
    ['server', new RegExp('(\\d+)\\+?\\s+'+W+'servers?\\b','g')],
    ['phone',  new RegExp('(\\d+)\\+?\\s+'+W+'(?:ip\\s+)?phones?\\b','g')],
    ['printer',new RegExp('(\\d+)\\+?\\s+'+W+'(?:printers?|scanners?)\\b','g')],
    ['arm',    new RegExp('(\\d+)\\+?\\s+'+W+'(?:monitor\\s+)?arms?\\b','g')],
    ['unbox',  new RegExp('(\\d+)\\+?\\s+'+W+'unbox\\w*\\b','g')], // "unboxed", not "removed 100 boxes" (hauling isn't the unboxing service)
    ['deploy', new RegExp('(\\d+)\\+?\\s+'+W+'(?:new\\s+(?:systems?|hires?)|deploy\\w*)\\b','g')],
    ['reconnect', new RegExp('(\\d+)\\+?\\s+'+W+'(?:reconnect\\w*|set\\s?ups?|setups?)\\b','g')],
    ['partial', new RegExp('(\\d+)\\+?\\s+'+W+'(?:disconnect\\w*|decom\\w*|taken\\s+down|takedowns?)\\b','g')],
  ];
  rules.forEach(([key,re])=>{
    t=t.replace(re,(m,n)=>{ units[key]=(units[key]||0)+(+n); hits++; return ' '.repeat(m.length); });
  });
  const bare=String(text||'').trim().match(/^(\d+)(?:\.0+)?$/);
  if(!hits&&bare){ units.dr=+bare[1]; return {units, sure:false}; }
  return {units, sure:hits>0};
}
function finPrice(client,key){
  const s=fin.settings, o=s.clientPrices&&s.clientPrices[client];
  if(o&&o[key]!=null) return o[key];
  return s.prices? s.prices[key] : null;
}
// Everything the views need for one job.
function finCalc(j){
  const s=fin.settings, rr=s.roleRates||{};
  const reps=j.reports||[];
  const repHours=reps.reduce((a,r)=>a+(r.totalHours||0),0);
  const repCrew=reps.reduce((a,r)=>Math.max(a,r.crewSize||0),0);
  const crew=repCrew||j.crewSize||((j.lead||[]).length+(j.technicians||[]).length)||1;
  let hours=0, hoursSrc='none';
  if(repHours>0){ hours=repHours; hoursSrc='report'; }
  else { const d=parseFloat(j.duration)||0; if(d>0){ hours=d*crew; hoursSrc='estimate'; } }
  const leads=Math.min(crew,Math.max(1,(j.lead||[]).length));
  let leadH=hours/crew*leads, techH=hours-leadH, pmH=0;
  const sv=j.saved, ho=(sv&&sv.hours)||{};
  if(ho.lead!=null) leadH=ho.lead; if(ho.tech!=null) techH=ho.tech; if(ho.pm!=null) pmH=ho.pm;
  if(ho.lead!=null||ho.tech!=null||ho.pm!=null){ hours=leadH+techH+pmH; hoursSrc='override'; }
  const rateMissing=[leadH>0&&rr.lead==null, techH>0&&rr.tech==null, pmH>0&&rr.pm==null].some(Boolean);
  // Overtime: hours a person worked past the weekly limit on THIS job (set by
  // finApplyOvertime across the whole loaded range) cost extra on their role rate.
  const ot=j.ot||{lead:0,tech:0}, otPct=(s.overtimePct||0)/100;
  const otCost=otPct? (ot.lead*(rr.lead||0)+ot.tech*(rr.tech||0))*otPct : 0;
  // Materials: confirmed list, else what the report mentions; cost (and billed price) per job.
  const cat=finMaterials(), matUsed= sv&&sv.materials? sv.materials : finSuggestMaterials(reps.map(r=>r.materials).join(', '));
  let matCost=0, matRevenue=0, matMissing=false;
  Object.keys(matUsed).forEach(k=>{ const m=cat.find(x=>x.key===k); if(!m) return; const q=matUsed[k]||0;
    if(m.cost==null) matMissing=true; matCost+=q*(m.cost||0); if(m.price!=null) matRevenue+=q*m.price; });
  const cost=leadH*(rr.lead||0)+techH*(rr.tech||0)+pmH*(rr.pm||0)+otCost+matCost;
  let units, unitsSrc;
  if(sv){ units=sv.units||{}; unitsSrc='confirmed'; }
  else { const sg=finSuggest(reps.map(r=>r.deviceQty).join(' ; ')); units=sg.units; unitsSrc=Object.keys(units).length? (sg.sure?'suggested':'guess') : 'none'; }
  let revenue=0, priceMissing=false;
  (fin.items||[]).forEach(it=>{
    let q=units[it.key]||0; if(!q) return;
    if(it.key==='support'&&q<(s.minCallHours||0)) q=s.minCallHours; // call-out minimum
    const p=finPrice(j.client,it.key); if(p==null){ priceMissing=true; return; }
    revenue+=q*p;
  });
  // Shift premium on the share of the work done 11 PM–6 AM. Unconfirmed jobs get it
  // automatically when the times say so; a confirmed job uses the box Finance ticked.
  revenue+=matRevenue; // billed materials aren't shift-premium work
  const night=finNightInfo(j), pct=(s.shiftPremiumPct||0)/100, base=revenue-matRevenue;
  const shiftFrac= sv? (sv.shift? (night.fraction>0? night.fraction : 1) : 0) : night.fraction;
  const shiftAmount=base*pct*shiftFrac;
  revenue+=shiftAmount;
  const shiftMissed= (sv&&!sv.shift&&night.fraction>0&&pct>0)? base*pct*night.fraction : 0;
  // Call-out minimum: min hours x support rate, per visit (or per tech if set).
  const supportP=finPrice(j.client,'support');
  const minimum= (supportP!=null&&s.minCallHours)? s.minCallHours*supportP*(s.minPerTech? crew : 1) : null;
  const belowMin= minimum!=null&&revenue>0&&revenue<minimum? minimum-revenue : 0;
  const margin=revenue-cost;
  return {hours, hoursSrc, crew, leadH, techH, pmH, cost, rateMissing, units, unitsSrc, revenue, priceMissing, margin,
    marginPct: revenue>0? margin/revenue : null, perHour: hours>0? revenue/hours : null,
    night, shiftFrac, shiftAmount, shiftMissed, minimum, belowMin,
    ot, otCost, matUsed, matCost, matRevenue, matMissing, matSrc: sv&&sv.materials? 'confirmed' : (Object.keys(matUsed).length? 'suggested' : 'none')};
}

// ── Materials catalog ──
// Techs list what they brought in "JCIT Provided Parts/Materials Used" with no
// quantities, and it's mostly TOOLS (drills, wire cutters, laptops) -- so the
// catalog prices consumables PER JOB when used, and tools are ignored. Names +
// keywords below come from what techs actually write; costs/prices are set in
// Settings (stored in Azure, never here).
const FIN_DEFAULT_MATERIALS=[
  {key:'velcro',name:'Velcro / cable ties',keywords:'velcro, velco, cable ties, zip ties'},
  {key:'bags-bands',name:'Bags & bands',keywords:'bags, bands, bag, rubber bands'},
  {key:'move-sheets',name:'Move sheets & labels',keywords:'move sheets, movesheets, sheets, labels, sticky notes'},
  {key:'screws',name:'Screws / hardware',keywords:'screws, bolts, hardware'},
  {key:'packing',name:'Bubble wrap / packing',keywords:'bubble wrap, packing, boxes, tape'},
  {key:'trash-bags',name:'Trash bags',keywords:'trash bags, big trash bags, garbage bags'},
];
const FIN_TOOL_RE=/\b(tape ?measures?|measuring tapes?|drills?|wire ?cutters?|wire clippers|snips|laptops?|tablets?|allen keys?|hex wrench|hand ?tools?|tools?|carts?|wagons?|flashlights?|phones?|smart ?phones?|lexicruiser|smartsheet)\b/gi;
function finMaterials(){
  const s=fin.settings||{}; const list=Array.isArray(s.materials)? s.materials : FIN_DEFAULT_MATERIALS; // [] = none (null = never set up -> defaults)
  return list.map(m=>Object.assign({cost:null,price:null},m));
}
function finSuggestMaterials(text){
  const t=' '+String(text||'').toLowerCase().replace(FIN_TOOL_RE,' ')+' ', out={};
  if(!finMeaningful(text)) return out;
  // Longest keywords first so "trash bags" beats "bags".
  const kws=[]; finMaterials().forEach(m=>String(m.keywords||m.name).split(',').map(k=>k.trim().toLowerCase()).filter(Boolean).forEach(k=>kws.push({k,key:m.key})));
  kws.sort((a,b)=>b.k.length-a.k.length);
  let rest=t; kws.forEach(({k,key})=>{ const re=new RegExp('(^|[^a-z])'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=[^a-z]|$)','g');
    if(re.test(rest)){ out[key]=1; rest=rest.replace(re,'$1'+' '.repeat(k.length)); } });
  return out;
}

// ── Weekly overtime ──
// Per person per Mon–Sun week, hours past the limit (default 40) are overtime.
// A person's hours on a job = the report's Total Hours ÷ crew size, else the
// calendar duration. Jobs are walked in date/start order, so the overtime lands
// on the job(s) that pushed someone over. Needs whole weeks loaded (the tab and
// the email both pad their date range to Mon–Sun).
function finWeekKey(iso){ const d=new Date(+iso.slice(0,4),+iso.slice(5,7)-1,+iso.slice(8,10)); d.setDate(d.getDate()-((d.getDay()+6)%7)); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function finApplyOvertime(jobs){
  const s=fin.settings||{}, limit=s.otWeeklyHours||40, acc={};
  const order=jobs.slice().sort((a,b)=> String(a.date).localeCompare(String(b.date)) || ((finParseTime(a.startTime)||0)-(finParseTime(b.startTime)||0)));
  order.forEach(j=>{
    j.ot={lead:0,tech:0};
    const leads=(j.lead||[]).filter(Boolean), techs=(j.technicians||[]).filter(n=>n&&!leads.includes(n)), people=leads.concat(techs);
    if(!people.length) return;
    const reps=j.reports||[], repH=reps.reduce((a,r)=>a+(r.totalHours||0),0), repCrew=reps.reduce((a,r)=>Math.max(a,r.crewSize||0),0);
    const per= repH>0? repH/Math.max(1,repCrew||people.length) : (parseFloat(j.duration)||0);
    if(!(per>0)) return;
    const wk=finWeekKey(j.date);
    people.forEach(p=>{ const key=String(p).toLowerCase()+'|'+wk, before=acc[key]||0, after=before+per; acc[key]=after;
      const over=Math.max(0,after-Math.max(limit,before)); if(over>0) j.ot[leads.includes(p)?'lead':'tech']+=over; });
  });
  return jobs;
}

// ── Possible extra billing ──
// "9:00AM", "09:00 AM", "7:22PM", "21:30" -> minutes after midnight (or null).
function finParseTime(t){
  const m=String(t||'').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?$/i); if(!m) return null;
  let h=+m[1]; const mi=+(m[2]||0), ap=(m[3]||'').toLowerCase();
  if(h>24||mi>59) return null;
  if(ap==='p'&&h<12) h+=12; if(ap==='a'&&h===12) h=0;
  return h*60+mi;
}
// How much of the job fell in the 11 PM–6 AM window. Uses the report's actual
// start/finish when there is one (checked against its Duration, so a typo like
// "10:00AM → 12:30AM" for a 2.25 h job is read as 12:30 PM), else the calendar's
// start time + duration.
function finNightInfo(j){
  const rep=(j.reports||[]).find(r=>finParseTime(r.start)!=null);
  let S, E, src;
  if(rep){
    S=finParseTime(rep.start); const F=finParseTime(rep.finish), D=rep.duration;
    if(F!=null){ E=F<=S? F+1440 : F; if(D&&Math.abs((E-S)/60-D)>1.5) E=S+D*60; }
    else if(D) E=S+D*60;
    src='report';
  } else {
    S=finParseTime(j.startTime); const D=parseFloat(j.duration)||0;
    if(S!=null&&D>0){ E=S+D*60; src='calendar'; }
  }
  if(S==null||E==null||E<=S) return {fraction:0, hours:0, src:'', span:''};
  const ov=(a,b)=>Math.max(0,Math.min(E,b)-Math.max(S,a));
  const nightMin=ov(-60,360)+ov(1380,1800)+ov(2820,3240); // early-morning, overnight, next overnight
  const fmt=m=>{ m=((m%1440)+1440)%1440; const h=Math.floor(m/60), mi=m%60; return ((h%12)||12)+':'+String(mi).padStart(2,'0')+(h<12?' AM':' PM'); };
  return {fraction: nightMin/(E-S), hours: nightMin/60, src, span: fmt(S)+'–'+fmt(E)};
}
// Report text that says nothing ("None", "na", "N/A", "no", "0.0") vs something real.
function finMeaningful(t){
  const s=String(t||'').trim(); if(!s) return '';
  const rest=s.replace(/^(?:none|no|na|n\/a|nothing|0(?:\.0+)?|-+|x)\b[\s.,;:!-]*/i,'').trim();
  return /[a-z]{3,}/i.test(rest)? s : '';
}
// "2 hours and 15 minutes", "3 hours 45 min", "30min extra", "1.5 hrs" -> hours.
function finTextHours(t){
  let s=' '+String(t||'').toLowerCase()+' ', h=0;
  s=s.replace(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:\s*(?:and|&)?\s*(\d+)\s*(?:minutes?|mins?|m)\b)?/g,(m,a,b)=>{ h+=(+a)+(b? +b/60 : 0); return ' '; });
  s.replace(/(\d+)\s*(?:minutes?|mins?)\b/g,(m,a)=>{ h+=(+a)/60; return ' '; });
  return Math.round(h*100)/100;
}
const FIN_BILLABLE_RE=/\b(access|badge|wait(?:ed|ing)?|delay\w*|late|no power|power|elevator|dock|driv\w*|travel|extra|charg\w*|added|additional|change order|\bco\b|minimum|not ready|blocked|locked)\b/i;
const FIN_FLAG_LABEL={shift:'Overnight shift premium',minimum:'Below call-out minimum',delay:'Delays / added scope',report:'No Daily Report'};
// Every open question about money on one job: [{kind, text, amount, likely}]
function finFlagsFor(j,c){
  const out=[], s=fin.settings, today=finIso(new Date());
  if(c.night.fraction>0) out.push({kind:'shift', amount: c.shiftMissed||null,
    text:`Worked ${c.night.span} (${finNum(c.night.hours)} h overnight, from the ${c.night.src==='report'?'Daily Report':'calendar'})`+
      (c.shiftMissed? ` — confirmed WITHOUT the premium` : (j.saved? ' — premium applied' : ' — premium included in the estimate'))});
  if(c.belowMin>0) out.push({kind:'minimum', amount:c.belowMin,
    text:`Billed ${finMoney(c.revenue)}; the ${s.minCallHours}-hour minimum is ${finMoney(c.minimum)}${s.minPerTech?' ('+c.crew+' techs)':''}`});
  const parts=[];
  (j.reports||[]).forEach(r=>{
    const sc=finMeaningful(r.scope), co=finMeaningful(r.coImpact);
    if(sc) parts.push({label:'Added scope / delays', t:sc}); if(co) parts.push({label:'CO impact', t:co});
    if((sc&&/work details/i.test(sc)||co&&/work details/i.test(co))&&r.work) parts.push({label:'Work details', t:r.work});
  });
  if(parts.length){
    const all=parts.map(p=>p.t).join(' ');
    const hrs=finTextHours(parts.filter(p=>p.label!=='Work details').map(p=>p.t).join(' ')), sp=finPrice(j.client,'support');
    out.push({kind:'delay', amount: hrs&&sp!=null? hrs*sp : null, hours:hrs, likely:FIN_BILLABLE_RE.test(all),
      text:parts.map(p=>`<b>${jsEsc(p.label)}:</b> ${jsEsc(p.t)}`).join('<br>'), html:true});
  }
  if(!(j.reports||[]).length && j.date<today) out.push({kind:'report', amount:null, text:'No Daily Project Report found — hours are estimated and there\'s no record of delays or extra work.'});
  return out.map(f=>Object.assign(f,{status:(j.flags&&j.flags[f.kind]&&j.flags[f.kind].status)||'', decision:(j.flags||{})[f.kind]||null}));
}
function finWeekEnd(iso){ const k=finWeekKey(iso), d=new Date(+k.slice(0,4),+k.slice(5,7)-1,+k.slice(8,10)+6); return finIso(d); }
  // ---- END COPY FROM index.html ----
  return { finCalc, finFlagsFor, finSuggest, finPrice, finApplyOvertime, finMaterials, finSuggestMaterials, finMoney, finNum, jsEsc };
}

module.exports = { createFinanceCalc };
