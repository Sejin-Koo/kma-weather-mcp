// kma-weather-mcp / lib/icon.js
//
// 날씨 값 앞에 붙일 이모지 아이콘. 원래 값(하늘상태·강수형태·날씨 문구)은 건드리지 않고
// 같은 객체에 `아이콘` 필드를 하나 더 끼운다(첫 날씨 필드 바로 앞) — 다른 시스템이 문구로 비교·집계해도 어긋나지 않게.
//
// 판정 순서: 강수(코드 1~7 또는 '없음'이 아닌 강수 문구) → 날씨 문구 → 하늘상태. 강수가 하늘보다 먼저다(흐리고 비 → 🌧️).
// 서버 응답 전체를 ok()에서 한 번 훑어 붙이므로 도구마다 따로 손대지 않는다.
//
// ── 코드표 ──────────────────────────────────────────────────────────────────
// 동네예보 SKY 1 맑음·3 구름많음·4 흐림 / PTY 0 없음·1 비·2 비/눈·3 눈·4 소나기·5 빗방울·6 빗방울눈날림·7 눈날림 (가이드)
// 관광코스 날씨 `sky`는 명세 표가 빠져 있어 실측으로만 정했다(2026-10-16): 1·3·4는 강수확률 분포가 동네예보 하늘상태와 같았고,
//   5는 봉화 춘양목 송이마을 10-18 21시 sky=5 ↔ 같은 곳 단기예보 강수형태 '비'(강수확률 70) — 실측 1건. 그 밖의 값은 아이콘을 붙이지 않는다.

export const ICON = {
  맑음: "☀️", 구름조금: "🌤️", 구름많음: "⛅", 흐림: "☁️",
  비: "🌧️", 비눈: "🌨️", 눈: "❄️", 소나기: "🌦️", 빗방울: "💧", 눈날림: "🌨️", 안개: "🌫️",
};
const SKY_CODE = { 1: ICON.맑음, 3: ICON.구름많음, 4: ICON.흐림 };
const PTY_CODE = { 1: ICON.비, 2: ICON.비눈, 3: ICON.눈, 4: ICON.소나기, 5: ICON.빗방울, 6: ICON.비눈, 7: ICON.눈날림 };
const TOUR_SKY = { 1: ICON.맑음, 3: ICON.구름많음, 4: ICON.흐림, 5: ICON.비 };

/** 날씨 문구 → 아이콘(강수 우선). 해당 없으면 null */
export function iconByText(s) {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, "");
  if (!t || /^(없음|현상없음|-|null)$/.test(t)) return null;
  if (/빗방울눈날림/.test(t)) return ICON.비눈;
  if (/비\/눈|눈\/비|비또는눈|눈또는비|비나눈|비·눈|눈·비|비또는눈/.test(t)) return ICON.비눈;
  if (/눈날림/.test(t)) return ICON.눈날림;
  if (/소나기/.test(t)) return ICON.소나기;
  if (/빗방울/.test(t)) return ICON.빗방울;
  if (/눈/.test(t)) return ICON.눈;
  if (/비/.test(t)) return ICON.비;
  if (/안개/.test(t)) return ICON.안개;
  if (/흐/.test(t)) return ICON.흐림;
  if (/구름많/.test(t)) return ICON.구름많음;
  if (/구름조금/.test(t)) return ICON.구름조금;
  if (/맑/.test(t)) return ICON.맑음;
  return null;
}

const isCode = (v) => typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v));

function precipIcon(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const i = precipIcon(x);
      if (i) return i;
    }
    return null;
  }
  if (isCode(v)) return PTY_CODE[Number(v)] ?? null;
  return iconByText(v);
}

function skyIcon(v) {
  if (v === null || v === undefined) return null;
  if (isCode(v)) return SKY_CODE[Number(v)] ?? null;
  return iconByText(v);
}

const WEATHER_KEYS = ["날씨", "하늘상태", "하늘상태_해석", "하늘", "하늘상태_09시", "하늘상태_15시", "강수형태", "강수형태_해석", "강수", "도로날씨", "sky"];

/** 객체 하나의 아이콘. 날씨 필드가 없거나 판정이 안 되면 null */
export function iconOf(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if ("sky" in o && "th3" in o) return isCode(o.sky) ? TOUR_SKY[Number(o.sky)] ?? null : null; // 관광코스 날씨
  if ("도로날씨" in o) return iconByText(o.도로날씨);
  const p = precipIcon(o.강수형태_해석 ?? o.강수형태 ?? (typeof o.강수 === "string" ? o.강수 : null));
  if (p) return p;
  if (typeof o.날씨 === "string") {
    const w = iconByText(o.날씨);
    if (w) return w;
  }
  return skyIcon(o.하늘상태_해석 ?? (typeof o.하늘상태 !== "object" ? o.하늘상태 : null) ?? o.하늘 ?? o.하늘상태_15시 ?? o.하늘상태_09시);
}

/** 응답 전체를 훑어 날씨 필드가 있는 객체마다 `아이콘`을 첫 날씨 필드 앞에 끼운다(이미 있으면 그대로) */
export function decorateIcons(x) {
  if (Array.isArray(x)) return x.map(decorateIcons);
  if (!x || typeof x !== "object") return x;
  const keys = Object.keys(x);
  const first = keys.find((k) => WEATHER_KEYS.includes(k) && (x[k] === null || typeof x[k] !== "object" || Array.isArray(x[k])));
  const icon = first && !("아이콘" in x) ? iconOf(x) : null;
  const out = {};
  for (const k of keys) {
    if (icon && k === first) out.아이콘 = icon;
    out[k] = decorateIcons(x[k]);
  }
  return out;
}
