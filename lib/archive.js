// kma-weather-mcp / lib/archive.js
//
// 과거 예보 발표분(API허브 typ01) — "그때 기상청이 어떻게 예보했나".
//   단기 육상  fct_afs_dl2.php  도시 구역 반나절(체감온도 포함)        단기 해상  fct_afs_do.php
//   단기 개황  fct_afs_ds.php   관서별 문장                            중기 육상  fct_afs_wl.php
//   중기 기온  fct_afs_wc.php   (tmef1·tmef2로 예보 대상일 지정 가능)   중기 해상  fct_afs_wo.php
//   중기 전망  fct_afs_ws.php   관서별 문장                            격자 단기  cgi-bin nph-dfs_shrt_grd(발표·예보시각·요소 1개당 전국 격자 1장)
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 2026-10-14 시점에 별도 활용신청 없이 모두 HTTP 200(이미 승인 상태)이었다.
// ★ 보관 범위: 단기 육상은 2010-07 발표분, 중기 기온은 2015-07 발표분도 나왔다. 격자 단기는 2021-07 있음·2021-01 없음.
// ★ 크기: 단기 육상 전국 구역 1주 = 38,976행, 1개월 = 16.5MB → 구역(reg)을 반드시 지정한다. 구역 하나 1개월 = 93발표·85KB.
// ★ 중기 기온에 tmef1=tmef2=20250805를 주니 07-26~08-01 발표 13건의 그날 예보만 왔다 → '예보가 발표마다 어떻게 바뀌었나'에 쓴다.
//   단기는 같은 필터를 명세에 적지 않아 서버가 발효시각으로 거른다.
// ★ 응답에 예보관 ID·이름(MAN_ID·MAN_FC, 개황·전망 머리줄의 이름)이 들어 있다 → 서버가 빼고 돌려준다.
// ★ 격자: 파일 값의 순서는 (ny-1)*149+(nx-1) — 이 서버의 격자(nx,ny)와 같다(산지·해안 7지점 대조 6/7 일치, 나머지 1곳은 바다 칸이라 격자 파일이 -99).
//   API허브 좌표→격자 변환(nph-dfs_xy_lonlat)은 서울시청을 61·128로 돌려줘 이 서버(60·127)와 1칸 어긋난다 — 그 변환은 쓰지 않는다.
//   vars는 한 번에 하나만(TMP,POP를 주면 전 격자 -99). 없는 발표시각(16시 등)도 HTTP 200에 전 격자 -99로 온다 → 자료 없음으로 판정.
// ★ PREP 4는 2019-06-04 전에는 눈/비, 그 뒤로는 소나기다(명세).

import { UpstreamError } from "./common.js";
import { hubGet } from "./hub.js";

const pad = (n) => String(n).padStart(2, "0");
const fmt = (t) => (t && t.length >= 12 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : t);
const fmtD = (t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
const nnum = (v) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) || n <= -99 ? null : n;
};

const SKY = { DB01: "맑음", DB02: "구름조금", DB03: "구름많음", DB04: "흐림", WB01: "맑음", WB02: "구름조금", WB03: "구름많음", WB04: "흐림" };
const PRE_W = { WB09: "비", WB11: "비/눈", WB13: "눈/비", WB12: "눈" };
const DIR = { N: "북", NNE: "북북동", NE: "북동", ENE: "동북동", E: "동", ESE: "동남동", SE: "남동", SSE: "남남동", S: "남", SSW: "남남서", SW: "남서", WSW: "서남서", W: "서", WNW: "서북서", NW: "북서", NNW: "북북서" };
function prep(code, tmfc) {
  const c = String(code);
  if (c === "4") return tmfc < "201906040000" ? "눈/비" : "소나기";
  return { 0: "없음", 1: "비", 2: "비/눈", 3: "눈" }[c] ?? null;
}
function wind(w1, t, w2) {
  const a = DIR[w1] || w1 || null;
  const b = DIR[w2] || w2 || null;
  if (!a && !b) return null;
  if (!b || a === b) return a;
  return String(t) === "2" ? `${a} 후 ${b}` : `${a}~${b}`;
}

export const ARCHIVE_KINDS = {
  short_land: { file: "fct_afs_dl2.php", label: "단기예보 육상(과거 발표분)", table: true, mid: false },
  short_sea: { file: "fct_afs_do.php", label: "단기예보 해상(과거 발표분)", table: true, mid: false },
  short_text: { file: "fct_afs_ds.php", label: "단기예보 개황 문장(과거 발표분)", table: false, mid: false },
  mid_land: { file: "fct_afs_wl.php", label: "중기예보 육상(과거 발표분)", table: true, mid: true },
  mid_temp: { file: "fct_afs_wc.php", label: "중기예보 기온(과거 발표분)", table: true, mid: true },
  mid_sea: { file: "fct_afs_wo.php", label: "중기예보 해상(과거 발표분)", table: true, mid: true },
  mid_text: { file: "fct_afs_ws.php", label: "중기 전망 문장(과거 발표분)", table: false, mid: true },
};

/** 행: 따옴표 문자열(WF)을 떼고 공백으로 나눈다 → {before:[], wf, after:[]} */
function splitRow(line) {
  const m = line.match(/^(.*?)\s"(.*)"\s*(.*)$/);
  if (!m) return { before: line.trim().split(/\s+/), wf: null, after: [] };
  return { before: m[1].trim().split(/\s+/), wf: m[2], after: m[3].trim() ? m[3].trim().split(/\s+/) : [] };
}

function parseTable(kind, text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^[0-9A-Z]{8}\s+\d{12}\s+\d{12}/.test(line)) continue;
    const { before: b, wf, after } = splitRow(line);
    const base = { reg: b[0], tmFc: b[1], tmEf: b[2], mod: b[3] };
    if (kind === "short_land") {
      // REG TM_FC TM_EF MOD NE STN C [MAN_ID MAN_FC] W1 T W2 TA STA ST SKY PREP — 예보관 칸은 끝에서부터 세어 건너뛴다
      const t = b.slice(-8);
      rows.push({ ...base, ne: b[4], stn: b[5], w: wind(t[0], t[1], t[2]), ta: nnum(t[3]), sta: nnum(t[4]), st: nnum(t[5]), sky: SKY[t[6]] ?? t[6], pre: prep(t[7], base.tmFc), wf });
    } else if (kind === "short_sea") {
      // … W1 T W2 S1 S2 WH1 WH2 SKY PREP
      const t = b.slice(-9);
      rows.push({ ...base, ne: b[4], stn: b[5], w: wind(t[0], t[1], t[2]), ws: [nnum(t[3]), nnum(t[4])], wh: [nnum(t[5]), nnum(t[6])], sky: SKY[t[7]] ?? t[7], pre: prep(t[8], base.tmFc), wf });
    } else if (kind === "mid_land") {
      // REG TM_FC TM_EF MOD STN C SKY PRE CONF "WF" RN_ST
      rows.push({ ...base, stn: b[4], sky: SKY[b[6]] ?? b[6], pre: PRE_W[b[7]] ?? (b[7] === "WB00" || !b[7] ? "없음" : b[7]), conf: b[8] ?? null, wf, st: nnum(after[0]) });
    } else if (kind === "mid_temp") {
      // REG TM_FC TM_EF MOD STN C MIN MAX MIN_L MIN_H MAX_L MAX_H
      rows.push({ ...base, stn: b[4], min: nnum(b[6]), max: nnum(b[7]), minL: nnum(b[8]), minH: nnum(b[9]), maxL: nnum(b[10]), maxH: nnum(b[11]) });
    } else if (kind === "mid_sea") {
      // REG TM_FC TM_EF MOD STN C WH_A WH_B SKY PRE "WF"
      rows.push({ ...base, stn: b[4], wh: [nnum(b[6]), nnum(b[7])], sky: SKY[b[8]] ?? b[8], pre: PRE_W[b[9]] ?? (b[9] === "WB00" || !b[9] ? "없음" : b[9]), wf });
    }
  }
  return rows;
}

function parseDocs(text) {
  const docs = [];
  let cur = null;
  let sec = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("$0#")) {
      const f = line.split("#"); // $0 # stn # tmfc # tmin # cnt # 예보관명 #
      cur = { stn: f[1], tmFc: f[2], body: [] };
      docs.push(cur);
      sec = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^\$(\d)#(.*)$/);
    if (m) {
      sec = m[1];
      if (sec === "1" && m[2].trim()) cur.body.push(m[2]);
      continue;
    }
    if (line.trim() === "=") {
      sec = null;
      continue;
    }
    if (sec === "1") cur.body.push(line);
  }
  for (const d of docs) d.body = d.body.join("\n").replace(/#\s*$/, "").trim();
  return docs.filter((d) => d.body);
}

/** YYYYMMDD 또는 YYYYMMDDHH → 10자리 */
function tm10(v, name, end) {
  const s = String(v ?? "").replace(/\D/g, "");
  if (/^\d{8}$/.test(s)) return s + (end ? "23" : "00");
  if (/^\d{10}$/.test(s)) return s;
  if (/^\d{12}$/.test(s)) return s.slice(0, 10);
  throw new UpstreamError(`${name}는 YYYYMMDD 또는 YYYYMMDDHH입니다: "${v}"`, "BAD_PARAM");
}
const days = (a, b) => (Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / 86400000;

const slot = (r) => `${fmtD(r.tmEf)} ${r.mod === "A01" ? "하루" : +r.tmEf.slice(8, 10) < 12 ? "오전" : "오후"}`;

function rowOut(kind, r) {
  const o = { 발표시각: fmt(r.tmFc), 예보대상: slot(r) };
  if (kind === "short_land") Object.assign(o, { 날씨: r.wf, 하늘: r.sky, 강수: r.pre, 강수확률: r.st, [+r.tmEf.slice(8, 10) < 12 ? "최저기온" : "최고기온"]: r.ta, ...(r.sta !== null ? { 체감온도: r.sta } : {}), 바람: r.w });
  else if (kind === "short_sea") Object.assign(o, { 날씨: r.wf, 바람: r.w, 풍속: r.ws.every((x) => x === null) ? null : `${r.ws[0]}~${r.ws[1]}m/s`, 파고: r.wh.every((x) => x === null) ? null : `${r.wh[0]}~${r.wh[1]}m` });
  else if (kind === "mid_land") Object.assign(o, { 날씨: r.wf, 하늘: r.sky, 강수: r.pre, 강수확률: r.st, ...(r.conf && r.conf !== "없음" ? { 신뢰도: r.conf } : {}) });
  else if (kind === "mid_temp") Object.assign(o, { 최저기온: r.min, 최고기온: r.max, ...(r.minL !== null ? { 범위값: { 최저하한: r.minL, 최저상한: r.minH, 최고하한: r.maxL, 최고상한: r.maxH } } : {}) });
  else if (kind === "mid_sea") Object.assign(o, { 날씨: r.wf, 파고: r.wh.every((x) => x === null) ? null : `${r.wh[0]}~${r.wh[1]}m` });
  return o;
}

/**
 * @param {{kind, reg, stn, from, to, target, limit, maxChars}} a  from·to는 발표일(YYYYMMDD[HH]), target은 예보 대상일(YYYYMMDD)
 */
export async function forecastArchive({ kind, reg, stn, from, to, target, limit = 100, maxChars = 1500 }, meter) {
  const k = ARCHIVE_KINDS[kind];
  if (!k) throw new UpstreamError(`kind는 ${Object.keys(ARCHIVE_KINDS).join("·")} 중 하나입니다.`, "BAD_PARAM");
  const tgt = target ? String(target).replace(/\D/g, "").slice(0, 8) : null;
  if (tgt && !/^\d{8}$/.test(tgt)) throw new UpstreamError(`target_date는 YYYYMMDD입니다: "${target}"`, "BAD_PARAM");
  // 대상일만 주면 발표 기간을 대상일 기준으로 잡는다(단기 4일 전·중기 11일 전 ~ 대상일)
  let f = from ? tm10(from, "from") : null;
  let t = to ? tm10(to, "to", true) : null;
  if (!f && tgt) {
    const d = new Date(Date.UTC(+tgt.slice(0, 4), +tgt.slice(4, 6) - 1, +tgt.slice(6, 8)) - (k.mid ? 11 : 4) * 86400000);
    f = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00`;
    t = t || `${tgt}23`;
  }
  if (!f) throw new UpstreamError("from(발표 시작일 YYYYMMDD) 또는 target_date(예보 대상일)가 필요합니다.", "BAD_PARAM");
  if (!t) t = f.slice(0, 8) + "23";
  if (t < f) throw new UpstreamError(`to(${t})가 from(${f})보다 앞입니다.`, "BAD_PARAM");
  const maxDays = k.table ? (k.mid ? 92 : 62) : 31;
  if (days(f.slice(0, 8), t.slice(0, 8)) > maxDays) throw new UpstreamError(`${k.label}는 한 번에 발표일 ${maxDays}일까지입니다(구역 하나 단기 1개월 ≈ 93발표): ${f}~${t}. 기간을 나누세요.`, "BAD_PARAM");
  if (k.table && !reg) throw new UpstreamError(`${k.label}에는 구역코드(reg)가 필요합니다 — 전국 구역을 한 번에 받으면 1개월에 16MB가 넘습니다. place로 주거나 kma_find_code로 코드를 찾으세요.`, "BAD_PARAM");
  let q = `reg=${k.table ? reg : ""}&tmfc1=${f}&tmfc2=${t}&disp=0&help=0`;
  if (k.mid && k.table && tgt) q += `&tmef1=${tgt}&tmef2=${tgt}`;
  if (!k.table && stn) q += `&stn=${Number(stn)}`;
  const text = await hubGet(`/typ01/url/${k.file}?${q}`, { source: `기상청 API허브 ${k.label}(${k.file})`, meter, encoding: "euc-kr", timeoutMs: 20000 });
  const cond = { 발표기간: `${fmt(f + "00")} ~ ${fmt(t + "59")}`, ...(reg && k.table ? { 구역코드: reg } : {}), ...(tgt ? { 예보대상일: fmtD(tgt) } : {}), ...(!k.table && stn ? { 관서: stn } : {}) };

  if (!k.table) {
    let docs = parseDocs(text);
    if (stn) docs = docs.filter((d) => d.stn === String(Number(stn)));
    docs.sort((a, b) => b.tmFc.localeCompare(a.tmFc));
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const mc = Number(maxChars);
    return {
      종류: k.label, 조건: cond, 전체건수: docs.length, 반환건수: Math.min(n, docs.length),
      ...(docs.length > n ? { 잘림: `전체 ${docs.length}건 중 최근 ${n}건만 — limit(최대 50)·stn으로 좁히세요.` } : {}),
      문서: docs.slice(0, n).map((d) => ({ 발표시각: fmt(d.tmFc), 관서: d.stn, 본문: mc > 0 && d.body.length > mc ? d.body.slice(0, mc) + " …" : d.body })),
      안내: "예보관 이름은 뺐다. 문장은 발표 당시 그대로다.",
    };
  }

  let rows = parseTable(kind, text);
  if (tgt) rows = rows.filter((r) => r.tmEf.slice(0, 8) === tgt);
  rows.sort((a, b) => a.tmFc.localeCompare(b.tmFc) || a.tmEf.localeCompare(b.tmEf));
  const issues = [...new Set(rows.map((r) => r.tmFc))];
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const out = {
    종류: k.label, 조건: cond, 발표수: issues.length, 행수: rows.length,
    ...(issues.length ? { 첫발표: fmt(issues[0]), 마지막발표: fmt(issues.at(-1)) } : {}),
  };
  if (tgt && rows.length) {
    // 대상일 예보가 발표마다 어떻게 바뀌었나 — 발표시각 × 칸(오전·오후·하루)
    const by = new Map();
    for (const r of rows) {
      const key = r.tmFc;
      if (!by.has(key)) by.set(key, { 발표시각: fmt(r.tmFc), 칸: {} });
      const o = rowOut(kind, r);
      const part = o.예보대상.split(" ")[1];
      delete o.발표시각;
      delete o.예보대상;
      by.get(key).칸[part] = o;
    }
    out.발표별변화 = [...by.values()].slice(-n);
    out.안내 = "예보 대상일 하루에 대한 예보를 발표 순서대로 늘어놓았다(위가 오래된 발표). 예보관 정보는 뺐다.";
  } else {
    out.목록 = rows.slice(-n).map((r) => rowOut(kind, r));
    if (rows.length > n) out.잘림 = `전체 ${rows.length}행 중 최근 ${n}행만 — target_date로 하루를 고르거나 기간을 좁히세요.`;
    out.안내 = "발표마다 여러 칸(오전·오후 또는 하루)이 나온다. 특정 날짜의 예보 변화는 target_date로 본다. 예보관 정보는 뺐다.";
  }
  if (!rows.length) out.안내 = "그 기간·구역의 발표분이 없다 — 구역코드가 그 시점에 쓰이던 코드인지(구역은 개편될 수 있다)와 기간을 확인하라.";
  return out;
}

// ── 격자 단기예보(과거 발표분) ──────────────────────────────────────────────
export const GRID_VARS = { TMP: "기온(℃)", POP: "강수확률(%)", PTY: "강수형태", SKY: "하늘상태", PCP: "1시간강수량(mm)", SNO: "1시간신적설(cm)", REH: "습도(%)", WSD: "풍속(m/s)", VEC: "풍향(deg)", TMN: "최저기온", TMX: "최고기온", WAV: "파고(m)" };
const PTY_G = { 0: "없음", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기" };
const SKY_G = { 1: "맑음", 3: "구름많음", 4: "흐림" };
const SHORT_BASES = ["02", "05", "08", "11", "14", "17", "20", "23"];

export async function gridArchive({ nx, ny, tmfc, times, vars }, meter) {
  const fc = String(tmfc || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(fc) || !SHORT_BASES.includes(fc.slice(8, 10))) throw new UpstreamError(`격자 단기예보 발표시각(tmfc)은 YYYYMMDDHH, HH는 ${SHORT_BASES.join("·")}시입니다: "${tmfc}"`, "BAD_PARAM");
  const ts = (Array.isArray(times) ? times : String(times || "").split(/[\s,]+/)).map((x) => String(x).replace(/\D/g, "")).filter(Boolean);
  if (!ts.length || ts.some((x) => !/^\d{10}$/.test(x))) throw new UpstreamError("예보시각(times)은 YYYYMMDDHH를 쉼표로 1~4개 주세요.", "BAD_PARAM");
  const vs = (Array.isArray(vars) ? vars : String(vars || "TMP").split(/[\s,]+/)).map((x) => String(x).toUpperCase()).filter(Boolean);
  if (vs.some((v) => !GRID_VARS[v])) throw new UpstreamError(`요소(vars)는 ${Object.keys(GRID_VARS).join("·")} 중에서 고르세요.`, "BAD_PARAM");
  if (ts.length * vs.length > 8) throw new UpstreamError(`격자 파일은 (예보시각 × 요소) 하나당 전국 한 장(약 340KB)이라 한 번에 8장까지입니다: ${ts.length}×${vs.length}. 줄여 주세요.`, "BAD_PARAM");
  const idx = (ny - 1) * 149 + (nx - 1);
  const jobs = [];
  for (const t of ts) for (const v of vs) jobs.push({ t, v });
  const res = await Promise.all(
    jobs.map(async ({ t, v }) => {
      const text = await hubGet(`/typ01/cgi-bin/url/nph-dfs_shrt_grd?tmfc=${fc}&tmef=${t}&vars=${v}`, { source: "기상청 API허브 격자 단기예보(nph-dfs_shrt_grd)", meter, timeoutMs: 15000 });
      const vals = text.match(/-?\d+\.\d+/g) || [];
      if (vals.length < 149 * 253) throw new UpstreamError(`격자 파일 형식이 예상과 다릅니다(값 ${vals.length}개).`, "UPSTREAM");
      const any = vals.some((x) => Number(x) > -99);
      const raw = Number(vals[idx]);
      return { t, v, any, val: raw <= -99 ? null : raw };
    })
  );
  if (!res.some((r) => r.any)) throw new UpstreamError(`그 발표분(${fmt(fc + "00")})의 격자 자료가 없습니다(전 격자 결측) — 보관분은 2021-07부터 확인됐고 발표시각은 02·05·…·23시입니다.`, "NO_DATA");
  const table = ts.map((t) => {
    const o = { 예보시각: fmt(t + "00") };
    for (const v of vs) {
      const r = res.find((x) => x.t === t && x.v === v);
      let val = r.val;
      if (v === "PTY" && val !== null) val = PTY_G[val] ?? val;
      if (v === "SKY" && val !== null) val = SKY_G[val] ?? val;
      o[GRID_VARS[v]] = r.any ? val : "그 예보시각 자료 없음";
    }
    return o;
  });
  return {
    종류: "격자 단기예보(과거 발표분)", 발표시각: fmt(fc + "00"), 격자: { nx, ny }, 시각별: table,
    안내: "격자 값이 null이면 그 칸이 결측(바다 칸 등)이다. 예보시각이 발표 범위(약 3일) 밖이면 '자료 없음'이 나온다.",
  };
}
