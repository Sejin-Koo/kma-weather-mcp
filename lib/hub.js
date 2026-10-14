// kma-weather-mcp / lib/hub.js
//
// 기상청 API허브 typ01(url·cgi-bin) 공통 호출기 — #START7777 형식이 아닌 원천까지 함께 받는다.
// (특보 계열 #START7777 원천은 warnhub.js의 hubText가 따로 처리한다.)
//
// ★ 실측 2026-10-14:
//   · cgi-bin 계열(nph-land_*)은 오류를 HTTP 200 + 본문 "<Error>\n\t메시지" 로 준다
//     (예: "출발 시각은 현재 시간보다 3시간 이내여야 합니다."). 인증·권한 오류는 {"result":{"status":403,…}} JSON.
//   · typ01 공통으로 간헐 무응답(15초 무응답 후 다음 시도는 1~3초)이 난다 → 재시도한다.
//   · 영향예보 분포도(ifs_ilvl_dmap)는 PNG인데 Content-Type이 text/plain;charset=EUC-KR로 온다 → 파일 머리(매직 바이트)로 판정한다.

import { UpstreamError, httpGet, envKey, scrub } from "./common.js";

export const HUB = "https://apihub.kma.go.kr/api";

const PNG = [0x89, 0x50, 0x4e, 0x47];
const GIF = [0x47, 0x49, 0x46];
function imageType(buf) {
  const b = new Uint8Array(buf.slice(0, 4));
  if (PNG.every((x, i) => b[i] === x)) return "image/png";
  if (GIF.every((x, i) => b[i] === x)) return "image/gif";
  return null;
}

/**
 * @param {string} path  HUB 이후 경로 + 쿼리(예 "/typ01/url/ifs_fct_pstt.php?tmfc1=…")
 * @param {{source:string, meter?, timeoutMs?, tries?, encoding?, binary?}} o
 * @returns {Promise<string|{base64:string,mimeType:string,bytes:number}>}
 */
export async function hubGet(path, { source, meter, timeoutMs = 15000, tries = 3, encoding = "utf-8", binary = false } = {}) {
  const key = envKey("KMA_APIHUB_KEY");
  if (!key) throw new UpstreamError(`${source}는 기상청 API허브 키(KMA_APIHUB_KEY)가 필요합니다.`, "NO_KEY");
  const url = `${HUB}${path}${path.includes("?") ? "&" : "?"}authKey=${encodeURIComponent(key)}`;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpGet(url, { meter, source, timeoutMs, binary: true });
      if (r.status >= 500) {
        last = new UpstreamError(`${source}: HTTP ${r.status}`, "UPSTREAM");
        continue;
      }
      const head = new TextDecoder("utf-8").decode(r.buf.slice(0, 300));
      if (r.status >= 400 || /^\s*\{\s*"result"/.test(head)) {
        let st = r.status;
        let msg = "";
        try {
          const j = JSON.parse(new TextDecoder("utf-8").decode(r.buf));
          st = Number(j.result?.status) || st;
          msg = j.result?.message || "";
        } catch {}
        const kind = st === 401 ? "BAD_KEY" : st === 403 ? "UNAPPROVED" : st === 429 ? "RATE_LIMIT" : "UPSTREAM";
        throw new UpstreamError(`${source}: HTTP ${st} ${msg}${st === 403 ? " — API허브에서 이 API 활용신청 승인 여부를 확인하세요" : ""}`.trim(), kind);
      }
      if (binary) {
        const mime = imageType(r.buf);
        if (!mime) {
          const txt = new TextDecoder(encoding).decode(r.buf).trim();
          if (/^<Error>/i.test(txt)) throw new UpstreamError(`${source}: ${txt.replace(/^<Error>\s*/i, "").trim() || "오류 응답"}`, "BAD_PARAM");
          last = new UpstreamError(`${source}: 이미지가 아닌 응답(${r.contentType || "?"}, ${r.buf.byteLength}B): ${scrub(txt.slice(0, 100))}`, "UPSTREAM");
          continue;
        }
        return { base64: Buffer.from(r.buf).toString("base64"), mimeType: mime, bytes: r.buf.byteLength };
      }
      const text = new TextDecoder(encoding).decode(r.buf);
      const t = text.trim();
      if (/^<Error>/i.test(t)) throw new UpstreamError(`${source}: ${t.replace(/^<Error>\s*/i, "").trim() || "오류 응답"}`, "BAD_PARAM");
      return text;
    } catch (e) {
      if (e.code !== "TIMEOUT" && e.code !== "UPSTREAM") throw e;
      last = e;
    }
  }
  throw new UpstreamError(`${last ? last.message : source + " 응답 없음"} (${tries}회 시도 — API허브 typ01은 간헐적으로 무응답이 난다. 잠시 후 다시 시도)`, last?.code || "UPSTREAM");
}

/** CSV(쉼표) 데이터 행만 — '#' 주석·빈 줄 제외, 줄 끝 '=' 제거 */
export function csvRows(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    out.push(line.replace(/,?\s*=\s*$/, "").split(",").map((x) => x.trim()));
  }
  return out;
}

/** "nan"·빈값·-99 이하 결측 → null */
export function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || /^nan$/i.test(s) || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= -99) return null;
  return n;
}

const pad = (n) => String(n).padStart(2, "0");
export const fmt12 = (t) => (t && /^\d{12}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : t || null);
export function tmAdd(t12, minutes) {
  const d = new Date(Date.UTC(+t12.slice(0, 4), +t12.slice(4, 6) - 1, +t12.slice(6, 8), +t12.slice(8, 10), +t12.slice(10, 12)) + minutes * 60000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** 평면 근사 거리(km) */
export function distKm(lat1, lon1, lat2, lon2) {
  const c = Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt((lat2 - lat1) ** 2 + ((lon2 - lon1) * c) ** 2) * 111;
}

export const SKY_TXT = { 1: "맑음", 3: "구름많음", 4: "흐림" };
export const PTY_TXT = { 0: "없음", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기", 5: "빗방울", 6: "빗방울눈날림", 7: "눈날림" };
