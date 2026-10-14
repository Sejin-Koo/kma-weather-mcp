import openpyxl, csv, json, re, io, sys
S='원천파일 디렉터리/'
O='data/'
def js(name, comment, obj):
    open(O+name,'w',encoding='utf8').write('// '+comment+'\n// 자동 생성 파일(scripts/gen-data.py) — 직접 고치지 말 것.\nexport default '+json.dumps(obj,ensure_ascii=False,separators=(',',':'))+';\n')

# 1) 격자·행정구역 (행정구역코드 10자리 = 생활기상지수 areaNo)
wb=openpyxl.load_workbook(S+'x/z3/f0.xlsx',read_only=True,data_only=True)
ws=wb.worksheets[0]; rows=list(ws.iter_rows(values_only=True))[1:]
areas=[]
for r in rows:
    if not r[1]: continue
    code=str(r[1]).strip()
    lon=r[13]; lat=r[14]
    try: lon=round(float(lon),6); lat=round(float(lat),6)
    except: lon=lat=None
    nx=int(r[5]) if r[5] not in (None,'') else None
    ny=int(r[6]) if r[6] not in (None,'') else None
    areas.append([code,(r[2] or '').strip(),(r[3] or '').strip(),(r[4] or '').strip(),nx,ny,lon,lat])
print('areas',len(areas), 'noGrid',sum(1 for a in areas if a[4] is None), 'noLonLat', sum(1 for a in areas if a[6] is None))
js('areas.js','행정구역코드(10자리)·1~3단계 명칭·격자(nx,ny)·경위도 — 기상청 동네예보 격자 최종 업데이트 파일 20260701. 열: [코드,1단계,2단계,3단계,nx,ny,경도,위도]',areas)

# 2) 특보구역
wb=openpyxl.load_workbook(S+'x/z4/f1.xlsx',read_only=True,data_only=True)
s1=list(wb.worksheets[0].iter_rows(values_only=True))[2:]
s2=list(wb.worksheets[1].iter_rows(values_only=True))[1:]
up={}
for r in s2:
    if r[0]: up[str(r[0]).strip()]={'up':str(r[4]).strip() if r[4] not in (None,0,'0') else '', 'ko':(r[5] or '').strip(), 'name':(r[6] or '').strip()}
warn=[]
for r in s1:
    if not r[1]: continue
    c=str(r[1]).strip(); u=up.get(c,{})
    warn.append([c,(r[2] or '').strip(),u.get('up',''),u.get('name','')])
print('warn',len(warn))
js('warnzones.js','특보구역코드(areaCode) — 열: [코드,특보구역명,상위코드,정식명칭]. 기상청21 특보구역코드안내 xlsx',warn)

# 3) 중기 예보구역
wb=openpyxl.load_workbook(S+'x/z2/f1.xlsx',read_only=True,data_only=True)
m=list(wb.worksheets[0].iter_rows(values_only=True))[1:]
mid=[[str(r[0]).strip(),(r[1] or '').strip(),(r[2] or '').strip()] for r in m if r[0]]
print('mid',len(mid))
js('midregions.js','중기예보 구역코드 — 열: [코드,구역명,특성]. 특성 A=도시(육상예보), C=육상(육상예보·중기기온), H=해양(해상예보)',mid)

# 4) 관광지
txt=open(S+'x/z1/f1.csv','rb').read().decode('cp949')
rd=list(csv.reader(io.StringIO(txt)))[1:]
spots=[[r[0],int(r[1]),int(r[2]),r[3],r[4].strip(),round(float(r[5]),6),round(float(r[6]),6),int(r[7]) if r[7].strip() else None,int(r[8]) if r[8].strip() else None,r[9],r[10]] for r in rd if len(r)>=11 and r[1].strip()]
print('spots',len(spots))
# 코스명(별첨1)
t=open(S+'x/z1/f0.txt').read()
courses={}
for mm in re.finditer(r'^(\d+) \| ([^|\n]+) \| ([^\n]+)$',t,re.M):
    if len(mm.group(1))>6: continue
    cid=int(mm.group(1)); courses.setdefault(cid,{'name':mm.group(2).strip(),'spots':[]})['spots'].append(mm.group(3).strip())
cities={}
for line in t[t.find('#별첨3'):].split('\n'):
    p_=[x.strip() for x in line.split('|')]
    if p_ and re.fullmatch(r'\d{10}',p_[0]):
        names=[x for x in p_[1:] if x]
        if names: cities.setdefault(p_[0],names[0])
print('cities',len(cities))
print('courses in spec',len(courses),'courses in csv',len({s[1] for s in spots}))
js('tour.js','관광코스·관광지 — spots 열: [테마분류,코스ID,관광지ID,지역ID(10자리),관광지명,경도,위도,코스순서,이동시간(분),실내구분,테마명]; courses: {코스ID:{name,spots}} (별첨1); cities: {시군구ID(10자리):전체도시이름} (별첨3, 시군구별관광기후지수용)',{'spots':spots,'courses':{str(k):v for k,v in courses.items()},'cities':cities})

# 5) CCTV
t=open(S+'x/z5/f0.txt').read()
cc=[[a.strip(),b.strip(),c.strip()] for a,b,c in re.findall(r'CCTV 아이디 \| ([^|]+) \| (\S+) \| (.+)',t)]
print('cctv',len(cc),'unique ids',len({c[1] for c in cc}))
js('cctv.js','CCTV 도로날씨 관측지점(2024-12-20 확대본) — 열: [노선,CCTV ID,지점명]',[[c[1],c[0],c[2]] for c in cc])
