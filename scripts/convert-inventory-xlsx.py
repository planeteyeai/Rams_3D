"""Convert RAMS inventory Excel (Road + Service road sheets) into adani-inventory.json."""
import json
import math
from collections import Counter, OrderedDict
from datetime import datetime

import openpyxl

SRC = r'c:\Users\Kunal.Desale\Downloads\new rams format nanasa.xlsx'
OUT = r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\src\assets\data\adani-inventory.json'
MEDIAN = r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\src\assets\data\nanasa-median.json'
PROJECT = 'ADANI-NANASA (NPRPL)'
SHEETS = [('Road', 'main'), ('Service road', 'service')]
LINE_ASSETS = {'Kerb', 'Crash Barrier'}
LINE_GAP_KM = 0.05
EXCLUDED_SUBS = {'cautionary'}

ASSET_ALIASES = {
    'service road': 'Service Road',
    'bus stop': 'Bus Shelters',
    'truck layby': 'Truck Layby',
}

COLORS = OrderedDict([
    ('Kerb', '#78909C'),
    ('Crash Barrier', '#EA580C'),
    ('Trees', '#4CAF50'),
    ('Street Lights', '#FFC107'),
    ('Sign Boards', '#FF9800'),
    ('Median Plants', '#2E7D32'),
    ('Hazard Markers', '#FF6F00'),
    ('Culvert', '#795548'),
    ('Delineators', '#FFB300'),
    ('KM Stones', '#607D8B'),
    ('Service Road', '#FF5722'),
    ('Adjacent Road', '#1565C0'),
    ('Bus Shelters', '#00BCD4'),
    ('Bus Bays', '#00897B'),
    ('Fuel Station', '#3F51B5'),
    ('Pedestrian Guard Rail', '#9C27B0'),
    ('Solar Blinker', '#E91E63'),
    ('Toll Plaza', '#F44336'),
    ('Truck Layby', '#8BC34A'),
    ('Median Opening', '#CDDC39'),
])


def norm_asset(v):
    s = str(v or '').strip()
    return ASSET_ALIASES.get(s.lower(), s)


def norm_dir(v):
    s = str(v or '').strip().lower()
    if s.startswith('inc'):
        return 'Increasing'
    if s.startswith('dec'):
        return 'Decreasing'
    if s.startswith('med'):
        return 'Median'
    return str(v or '').strip() or 'Median'


def norm_date(v):
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d')
    s = str(v or '').strip()
    for fmt in ('%d-%m-%Y', '%Y-%m-%d', '%d/%m/%Y'):
        try:
            return datetime.strptime(s[:10], fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return s[:10]


def text(v):
    s = str(v).strip() if v is not None else ''
    return s or None


def norm_sub(v):
    s = text(v)
    return s[0].upper() + s[1:] if s and s.islower() else s


def read_rows():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    out = []
    for sheet, road in SHEETS:
        rows = wb[sheet].iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else '' for h in next(rows)]
        ix = {h: i for i, h in enumerate(header)}
        for r in rows:
            if not r or r[ix['Asset type']] is None:
                continue
            lat, lng = r[ix['Latitude']], r[ix['Longitude']]
            if lat is None or lng is None:
                continue
            if str(r[ix['Sub Asset Type']] or '').strip().lower() in EXCLUDED_SUBS:
                continue
            out.append({
                'project': text(r[ix['Project Name']]) or PROJECT,
                'asset': norm_asset(r[ix['Asset type']]),
                'sub': norm_sub(r[ix['Sub Asset Type']]),
                'lat': round(float(lat), 5),
                'lng': round(float(lng), 5),
                'start': round(float(r[ix['Chainage start']]), 3),
                'end': round(float(r[ix['Chainage end']]), 3),
                'dir': norm_dir(r[ix['Direction']]),
                'date': norm_date(r[ix['Date']]),
                'lane': text(r[ix['Lane']]),
                'road': road,
            })
    return out


def load_median():
    with open(MEDIAN, encoding='utf-8') as f:
        med = json.load(f)
    coords = med['coordinates'] if isinstance(med, dict) else med
    if isinstance(coords[0][0], list):
        coords = coords[0]
    return [(c[1], c[0]) for c in coords]


def extend_along_median(lat, lng, length_m, median):
    """Second vertex for a single-row run so the map can draw it as a short line."""
    k = math.cos(math.radians(lat))
    best = None
    for (a_lat, a_lng), (b_lat, b_lng) in zip(median, median[1:]):
        mx, my = ((a_lng + b_lng) / 2 - lng) * k, (a_lat + b_lat) / 2 - lat
        d = mx * mx + my * my
        if best is None or d < best[0]:
            best = (d, (b_lng - a_lng) * k, b_lat - a_lat)
    _, dx, dy = best
    norm = math.hypot(dx, dy) or 1
    deg = length_m / 111320
    return [round(lat + dy / norm * deg, 5), round(lng + dx / norm * deg / k, 5)]


def build_lines(rows, median):
    groups = {}
    for r in rows:
        groups.setdefault((r['asset'], r['road'], r['dir']), []).append(r)
    lines = []
    for (asset, road, direction), items in sorted(groups.items()):
        items.sort(key=lambda r: (r['start'], r['end']))
        run = None
        for r in items:
            if run is None or r['start'] - run['end'] > LINE_GAP_KM:
                run = {'asset': asset, 'road': road, 'dir': direction,
                       'start': r['start'], 'end': r['end'], 'n': 0, 'subs': Counter(),
                       'seen': set(), 'latlngs': []}
                lines.append(run)
            run['end'] = max(run['end'], r['end'])
            run['n'] += 1
            if r['sub']:
                run['subs'][r['sub']] += 1
            if r['start'] not in run['seen']:
                run['seen'].add(r['start'])
                run['latlngs'].append([r['lat'], r['lng']])
    out = []
    for i, run in enumerate(lines):
        rec = {'i': f'L{i}', 'asset': run['asset'], 'road': run['road'], 'dir': run['dir'],
               'start': run['start'], 'end': run['end'], 'n': run['n']}
        if run['subs']:
            rec['sub'] = run['subs'].most_common(1)[0][0]
        latlngs = run['latlngs']
        if len(latlngs) == 1:
            length_m = max(10.0, (run['end'] - run['start']) * 1000)
            latlngs = latlngs + [extend_along_median(*latlngs[0], length_m, median)]
        rec['latlngs'] = latlngs
        out.append(rec)
    return out


def main():
    rows = read_rows()
    line_rows = [r for r in rows if r['asset'] in LINE_ASSETS]
    point_rows = [r for r in rows if r['asset'] not in LINE_ASSETS]
    point_rows.sort(key=lambda r: (r['road'] != 'main', r['start'], r['dir'], r['asset']))

    points = []
    for i, r in enumerate(point_rows, 1):
        rec = {'i': i, **{k: v for k, v in r.items() if v is not None and k != 'lane'}}
        points.append(rec)
    lines = build_lines(line_rows, load_median())

    counts = Counter(r['asset'] for r in rows)
    kinds = {a: ('line' if a in LINE_ASSETS else 'point') for a in counts}
    order = list(COLORS) + sorted(a for a in counts if a not in COLORS)
    types = [{'id': a, 'n': counts[a], 'color': COLORS.get(a, '#64748B'), 'kind': kinds[a]}
             for a in order if counts.get(a)]
    dates = sorted({r['date'] for r in rows if r['date']}, reverse=True)

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'dates': dates, 'types': types, 'points': points, 'lines': lines},
                  f, ensure_ascii=False, separators=(',', ':'))

    print('rows', len(rows), 'points', len(points), 'lines', len(lines))
    print('projects', Counter(r['project'] for r in rows))
    print('dates', dates)
    print('by road', Counter((r['road'], r['asset']) for r in rows))
    print('line runs', Counter((l['asset'], l['road'], l['dir']) for l in lines))
    print('lines with <2 vertices', sum(1 for l in lines if len(l['latlngs']) < 2))


if __name__ == '__main__':
    main()
