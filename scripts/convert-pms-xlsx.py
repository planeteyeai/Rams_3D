"""Convert updated PMS Excel (Jun–Sep 2026) into adani-pms.json."""
import json
import math
from collections import Counter

import openpyxl

SRC = r'c:\Users\Kunal.Desale\Downloads\73584bc4cefd406ca190a1edcaba928d.xlsx'
OUTS = [
    r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\src\assets\data\adani-pms.json',
    r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\public\data\adani-pms.json',
]
PROJECT = 'ADANI-NANASA (NPRPL)'


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb.active

    # Pass 1: merge L1/L2 at native 10 m
    ten = {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or r[3] is None:
            continue
        start = float(r[3])
        end = float(r[4])
        date = str(r[5])[:10]
        direction = str(r[6] or 'Increasing')
        pav = str(r[7] or 'Bituminous').strip().lower()
        if pav.startswith('bit'):
            pav = 'bituminous'
        elif pav.startswith('conc'):
            pav = 'concrete'
        pcs = str(r[9] or '')
        try:
            iri = float(r[10])
        except (TypeError, ValueError):
            iri = None
        status = str(r[12] or '')
        flat, flng, tlat, tlng = r[20], r[21], r[25], r[26]
        key = (date, direction, round(start, 4), round(end, 4))
        if key not in ten:
            ten[key] = {
                'iriSum': 0.0,
                'iriN': 0,
                'pcs': pcs,
                'status': status,
                'flat': flat,
                'flng': flng,
                'tlat': tlat,
                'tlng': tlng,
                'start': start,
                'end': end,
                'date': date,
                'dir': direction,
                'pav': pav,
            }
        a = ten[key]
        if iri is not None:
            a['iriSum'] += iri
            a['iriN'] += 1
        if a['flat'] is None and flat is not None:
            a.update(flat=flat, flng=flng, tlat=tlat, tlng=tlng)
        if pav == 'concrete':
            a['pav'] = 'concrete'

    # Pass 2: roll up to 100 m bins (date × direction) for map/3D perf
    bins = {}
    for a in ten.values():
        b0 = math.floor(a['start'] * 10 + 1e-9) / 10
        b1 = round(b0 + 0.1, 2)
        key = (a['date'], a['dir'], b0)
        if key not in bins:
            bins[key] = {
                'iriSum': 0.0,
                'iriN': 0,
                'pcs': a['pcs'],
                'status': a['status'],
                'flat': a['flat'],
                'flng': a['flng'],
                'start': b0,
                'end': b1,
                'date': a['date'],
                'dir': a['dir'],
                'pav': a['pav'],
                'tlat_last': a['tlat'],
                'tlng_last': a['tlng'],
            }
        b = bins[key]
        if a['iriN']:
            b['iriSum'] += a['iriSum']
            b['iriN'] += a['iriN']
        if a['pav'] == 'concrete':
            b['pav'] = 'concrete'
        if b['flat'] is None and a['flat'] is not None:
            b.update(flat=a['flat'], flng=a['flng'])
        if a['tlat'] is not None:
            b['tlat_last'] = a['tlat']
            b['tlng_last'] = a['tlng']

    records = []
    for i, b in enumerate(sorted(bins.values(), key=lambda x: (x['date'], x['start'], x['dir']))):
        if b['flat'] is None or b['tlat_last'] is None:
            continue
        iri = (b['iriSum'] / b['iriN']) if b['iriN'] else None
        flat, flng = float(b['flat']), float(b['flng'])
        tlat, tlng = float(b['tlat_last']), float(b['tlng_last'])
        records.append({
            'i': i,
            'project': PROJECT,
            'pavement': b['pav'],
            'start': b['start'],
            'end': b['end'],
            'date': b['date'],
            'direction': b['dir'],
            'lat': (flat + tlat) / 2,
            'lng': (flng + tlng) / 2,
            'from': [flat, flng],
            'to': [tlat, tlng],
            'pcs': b['pcs'],
            'iri': round(iri, 6) if iri is not None else None,
            'iriStatus': b['status'],
        })

    dates = sorted({r['date'] for r in records}, reverse=True)
    payload = {'dates': dates, 'records': records}
    text = json.dumps(payload, separators=(',', ':'))
    for out in OUTS:
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text)
    print('dates', dates)
    print('records', len(records))
    print('byDate', dict(Counter(r['date'] for r in records)))
    print('bytes', len(text))
    print('sample', records[0])


if __name__ == '__main__':
    main()
