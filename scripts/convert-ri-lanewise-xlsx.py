"""Convert lane-wise 10 m RI Excel into adani-pms.json (100 m bins per lane)."""
import json
import math
from collections import Counter
from datetime import datetime

import openpyxl

SRC = r'c:\Users\Kunal.Desale\Downloads\ADANI_RI_10M_Lane_wise.xlsx'
OUTS = [
    r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\src\assets\data\adani-pms.json',
    r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\public\data\adani-pms.json',
]
PROJECT = 'ADANI-NANASA (NPRPL)'
BIN_KM = 0.1

# Rigid pavement near the toll plazas; the RI sheet labels every row Bituminous.
CONCRETE_BINS = {
    'Increasing': [(101.9, 102.2), (108.7, 109.0)],
    'Decreasing': [(101.8, 102.2), (108.7, 109.0)],
}

STATUS = {
    'good': 'Off carriageway maintenance',
    'fair': 'Distress repair and off carriageway maintenance',
    'poor': 'Distress repair + Thin Overlay / Strengthening Thick Overlay',
}


def survey_date(v):
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-15')
    s = str(v or '').strip()
    for fmt in ('%b %Y', '%B %Y', '%b-%y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-15')
        except ValueError:
            pass
    return None


def is_concrete(direction, start):
    return any(a - 1e-6 <= start < b - 1e-6 for a, b in CONCRETE_BINS.get(direction, []))


def band(iri, pavement):
    if iri is None:
        return None
    cap = 2.0 if pavement == 'concrete' else 1.8
    return 'good' if iri < cap else 'fair' if iri <= 2.4 else 'poor'


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    rows = wb.active.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else '' for h in next(rows)]
    ix = {h: i for i, h in enumerate(header)}

    bins = {}
    skipped = Counter()
    for r in rows:
        if not r or r[ix['Chainage_Start']] is None:
            skipped['empty'] += 1
            continue
        date = survey_date(r[ix['Date']] or r[ix['Survey_period']])
        direction = str(r[ix['Direction']] or '').strip()
        lane = str(r[ix['Lane']] or '').strip().upper()
        if not date or direction not in ('Increasing', 'Decreasing') or lane not in ('L1', 'L2'):
            skipped['meta'] += 1
            continue
        start = float(r[ix['Chainage_Start']])
        b0 = round(math.floor(start / BIN_KM + 1e-9) * BIN_KM, 2)
        key = (date, direction, lane, b0)
        b = bins.get(key)
        if b is None:
            b = bins[key] = {
                'date': date, 'dir': direction, 'lane': lane, 'start': b0,
                'end': round(b0 + BIN_KM, 2), 'riSum': 0.0, 'riN': 0,
                'pcs': Counter(), 'from': None, 'to': None, 'fromCh': None, 'toCh': None,
            }
        ri = r[ix['RI']]
        if isinstance(ri, (int, float)) and ri > 0:
            b['riSum'] += float(ri)
            b['riN'] += 1
        else:
            skipped['no-ri'] += 1
        if r[ix['PCS']]:
            b['pcs'][str(r[ix['PCS']])] += 1
        flat, flng = r[ix['From Latitude']], r[ix['From Longitude']]
        tlat, tlng = r[ix['To Latitude']], r[ix['To Longitude']]
        if flat is not None and (b['fromCh'] is None or start < b['fromCh']):
            b['from'], b['fromCh'] = [float(flat), float(flng)], start
        if tlat is not None and (b['toCh'] is None or start > b['toCh']):
            b['to'], b['toCh'] = [float(tlat), float(tlng)], start

    records = []
    for b in sorted(bins.values(), key=lambda x: (x['date'], x['start'], x['dir'], x['lane'])):
        if b['from'] is None or b['to'] is None:
            skipped['no-gps'] += 1
            continue
        pavement = 'concrete' if is_concrete(b['dir'], b['start']) else 'bituminous'
        iri = round(b['riSum'] / b['riN'] / 1000, 4) if b['riN'] else None
        records.append({
            'i': len(records),
            'project': PROJECT,
            'pavement': pavement,
            'start': b['start'],
            'end': b['end'],
            'date': b['date'],
            'direction': b['dir'],
            'lane': b['lane'],
            'lat': round((b['from'][0] + b['to'][0]) / 2, 7),
            'lng': round((b['from'][1] + b['to'][1]) / 2, 7),
            'from': [round(v, 7) for v in b['from']],
            'to': [round(v, 7) for v in b['to']],
            'pcs': b['pcs'].most_common(1)[0][0] if b['pcs'] else '',
            'iri': iri,
            'iriStatus': STATUS.get(band(iri, pavement), ''),
        })

    dates = sorted({r['date'] for r in records}, reverse=True)
    text = json.dumps({'dates': dates, 'lanes': ['L1', 'L2'], 'records': records}, separators=(',', ':'))
    for out in OUTS:
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text)

    print('records', len(records), 'bytes', len(text))
    print('dates', dates)
    print('per date', dict(Counter(r['date'] for r in records)))
    print('lanes', dict(Counter((r['direction'], r['lane']) for r in records)))
    print('pavement', dict(Counter(r['pavement'] for r in records)))
    print('bands', dict(Counter(band(r['iri'], r['pavement']) for r in records)))
    print('skipped', dict(skipped))
    print('sample', records[0])


if __name__ == '__main__':
    main()
