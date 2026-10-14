# 2026-10-14 추가 코드표 생성 — API허브 활용가이드 첨부 엑셀에서 만든다.
#   python3 scripts/gen-data2.py <동네예보통보문_구역코드.xlsx> <고속도로날씨실황지점코드.xlsx> <고속도로단기예보지점코드.xlsx> <육상지점정보.xlsx>
import openpyxl, json, sys
O = 'data/'
def js(name, comment, obj):
    open(O + name, 'w', encoding='utf8').write('// ' + comment + '\n// 자동 생성 파일(scripts/gen-data2.py) — 직접 고치지 말 것.\nexport default ' + json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + ';\n')
def rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    return [r for r in ws.iter_rows(values_only=True) if any(c is not None for c in r)][1:]

msg_x, obs_x, fct_x, pt_x = sys.argv[1:5]

# 1) 동네예보 통보문 구역코드 — 열: [구분, 지역, 코드]. 구분: 개황(관서) / A 육상광역 / B 육상국지 / C 도시 / H 해상광역 / I 해상국지
KIND = {'개황': 'S', '육상광역(A)': 'A', '육상국지(B)': 'B', '도시(C)': 'C', '해상광역(H)': 'H', '해상국지(I)': 'I'}
msg = []
for r in rows(msg_x, 'Sheet2'):
    if not r[0] or r[2] is None: continue
    msg.append([KIND[str(r[0]).strip()], str(r[1]).strip(), str(r[2]).strip()])
print('fcstmsg', len(msg))
js('fcstmsg.js', '동네예보 통보문 구역코드(API허브 20260324 첨부) — 열: [구분 S개황관서·A육상광역·B육상국지·C도시·H해상광역·I해상국지, 지역명, 코드]', msg)

# 2) 고속도로 지점 — 예보 지점코드(노선별 진행 순서)와 실황 6자리 코드를 이름으로 잇고, 육상지점정보에서 좌표를 붙인다
fct = rows(fct_x)
obs = rows(obs_x)
pts = rows(pt_x)
obs_by = {(str(r[1]), str(r[6]).strip()): (str(r[0]), str(r[4]).strip()) for r in obs}
coord = {}
for r in pts:
    k = str(r[1]).strip()
    if k not in coord and r[3] is not None:
        coord[k] = [round(float(r[3]), 6), round(float(r[4]), 6)]
routes = {}
P = []
for r in fct:
    rc, pc, rname, pname = str(r[0]), str(r[1]), str(r[2]).strip(), str(r[3]).strip()
    routes[rc] = rname
    oc, typ = obs_by[(rc, pname)]
    base = rname.rsplit('-', 1)[0]
    ll = coord.get(base + '-' + pname, [None, None])
    P.append([rc, pc, pname, oc, typ] + ll)
print('highway points', len(P), 'routes', len(routes), 'no coord', sum(1 for p in P if p[5] is None))
js('highway.js', '고속도로 날씨 지점(API허브 첨부 지점코드 3종) — routes: {노선코드: 노선명-방향}, points 열: [노선코드, 예보지점코드(진행 순서), 지점명, 실황지점코드 6자리, 지점종류, 위도, 경도]', {'routes': routes, 'points': P})
