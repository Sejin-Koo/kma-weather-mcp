# kma-weather-mcp

기상청 OpenAPI(공공데이터포털·기상청 API허브)를 MCP 도구로 묶은 서버입니다. 저장소 없이 매번 실시간 조회하고, 지역명→격자·코드 변환용 코드표만 서버에 내장합니다.

## 도구

| 도구 | 하는 일 | 원천 오퍼레이션 |
|---|---|---|
| `kma_find_code` | 지역명·좌표 → 격자(nx,ny)·행정구역코드·특보구역·중기구역, 관광코스·시군구·CCTV 검색 (원천 호출 없음) | 내장 코드표 |
| `kma_short_forecast` | 동네예보 — 초단기실황·초단기예보·단기예보(시간별+일별 요약) | getUltraSrtNcst · getUltraSrtFcst · getVilageFcst |
| `kma_forecast_version` | 동네예보 발표 버전 | getFcstVersion |
| `kma_mid_forecast` | 중기예보 — 전망·육상·기온·해상 | getMidFcst · getMidLandFcst · getMidTa · getMidSeaFcst |
| `kma_warnings` | 기상특보·예비특보·기상정보·기상속보·구역별 발효 특보·현황 | getPwnStatus · getPwnCd · getWthrWrnList/Msg · getWthrPwnList/Pwn · getWthrInfoList/Info · getWthrBrkNewsList/BrkNews |
| `kma_tour_weather` | 관광코스별 관광지 예보·시군구 관광기후지수 | getTourStnVilageFcst1 · getCityTourClmIdx1 |
| `kma_road_weather` | CCTV 영상분석 도로날씨 | getCctvStnRoadWthr · getStdNodeLinkRoadWw |
| `kma_living_index` | 자외선·대기정체 지수 예측(시각별, 단계별 주의사항 포함) | getUVIdxV5 · getAirDiffusionIdxV5 |
| `kma_uv_observation` | 자외선 실측(10분 간격, 최신·과거·최근 N시간 추이) | API허브 typ01 `kma_sfctm_uv.php` |
| `kma_api_status` | 키·호스트·코드표 상태, `ping=true`면 실호출 점검 | — |

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `DATA_PORTAL_KEY` | 필수 | 공공데이터포털 인증키(여러 서버 공용). 6개 서비스 모두 활용신청·승인되어 있어야 합니다 |
| `MCP_GATE_KEYS` | 권장 | 접근 허용 키 목록(쉼표). 비어 있으면 게이트 비활성 |
| `MCP_GATE_MODE` | 권장 | `enforce`면 키 없는 호출을 401로 막습니다 |
| `KMA_APIHUB_KEY` | 권장 | 기상청 API허브(apihub.kma.go.kr) 인증키. 있으면 단기·중기예보를 허브 우선으로 조회 |
| `KMA_HUB_SERVICES` | 선택 | 허브 우선 서비스 목록(기본 `SHORT,MID`) |
| `KMA_HOST_SHORT` 등 | 선택 | `apihub`(허브만) 또는 `datago`(포털만)로 서비스별 강제 지정(`SHORT`·`MID`·`WARN`·`TOUR`·`ROAD`·`LIVING`) |

접속 주소: `https://<도메인>/api/mcp?k=<게이트키>`

## 호스트·키 격리

기상청은 일부 API를 API허브(`apihub.kma.go.kr`, `authKey`)로 옮기는 중입니다. 2026-10-14 실측으로 공공데이터포털 단기예보 피드에는 당일 08·11시 발표분이 없었고, 같은 시각 API허브에는 있었습니다. 그래서 `KMA_APIHUB_KEY`가 있으면 **단기예보·중기예보는 API허브를 먼저** 부르고, 허브가 인증·권한·서버 오류를 내면 공공데이터포털로 한 번 넘어갑니다(자료 없음 03은 넘어가지 않음). 기상특보는 허브에서 403(허브 쪽 미신청), 생활기상지수 V5는 404(허브에 없는 이름)라 포털로만 부릅니다. 응답 `메타.호스트`·`요약.원천별호출수`에 실제로 쓴 호스트가 나옵니다. 호스트 분기는 `lib/kma.js` 한 곳에 모아 두었습니다.

## 알려진 제약 (실측)

- 단기예보 `base_time`은 02·05·08·11·14·17·20·23시(+10분 이후 제공). 자료가 없으면 최대 6발표 전까지 물러서고, 물러선 경우 `메타.발표지연안내`에 어느 발표분을 썼는지 적습니다.
- **2026-10-14 실측**: 포털 단기예보 피드에 당일 02시 발표분만 있고 05·08시 발표분이 없었습니다(전날·전전날은 8개 모두 정상, 초단기실황·초단기예보도 정상). 같은 시각 API허브에는 있었으므로 포털 피드 지연으로 보고, 허브 우선 조회로 해결했습니다(위 절). `getFcstVersion`의 version이 `19700101090000`이면 그 발표분이 없다는 뜻입니다.
- 구역별 특보(`kind=area`, getPwnCd)는 오늘 기준 60일 전까지만 조회됩니다.
- 중기예보는 06시·18시 발표, **최근 24시간분만** 제공합니다.
- 결측(±900)은 null, 해상 격자는 값이 마스킹됩니다. PCP·SNO는 범주 문자열입니다.
- 한 페이지 상한이 조용히 깎일 수 있어 받은 행 수를 `totalCount`와 대조하고, 모자라면 응답에 경고를 적습니다.
- 호출 한도는 오퍼레이션별 일일 한도(공공데이터포털 개발계정 기준 오퍼레이션당 10,000회)이며 같은 키를 쓰는 다른 서버와 공유합니다(코드 22는 재시도 금지).
- 특보·중기 구역은 행정구역 이름 일치로 **추정**한 값입니다(기상청 공식 배정표 아님).
- 자외선 관측(`kma_sfctm_uv.php`)은 JSON이 아니라 EUC-KR 고정폭 텍스트입니다. `tm`을 비우면 정시 자료가 와서, 서버는 '지금-10분'부터 10분씩 거슬러 최신 10분 자료를 찾습니다. 지점명은 지점정보 API(`stn_inf.php`)가 미승인(403)이라 ASOS 지점번호 기준 추정이며 13번은 미확인입니다.
- 관광코스 명세서는 요청·응답 표가 이미지로 빠져 있으나, 공개 규약대로 보낸 파라미터(`CURRENT_DATE`·`HOUR`·`COURSE_ID` / `CURRENT_DATE`·`DAY`·`CITY_AREA_ID`)가 2026-10-14 실호출로 통했습니다. 응답 필드는 원본 그대로 돌려줍니다.

## 내장 코드표 (`data/`)

기상청 격자 최종 업데이트 파일(20260701) 3,838행, 특보구역코드 413, 중기예보 구역 240, 관광코스·관광지(2,785), 도로날씨 CCTV 861. `scripts/gen-data.py`로 원천 파일에서 생성합니다. 기상청이 코드표를 갱신하면 다시 생성해 교체합니다.

## 개발

```bash
npm install
node smoke.mjs                              # 키 없이: 도구 목록·내장 코드표·오류 경로
SMOKE_ENV_FILE=/경로/keys.env node smoke.mjs   # 실호출(DATA_PORTAL_KEY 필요)
```
