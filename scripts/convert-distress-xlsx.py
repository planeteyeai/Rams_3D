"""Convert 100 m chainage-wise distress Excel into adani-reported.json.

Main Road and Service Road sheets both replace the previous reported distress.
"""
import json
from datetime import datetime

import openpyxl

SRC = r'c:\Users\Kunal.Desale\Downloads\ADANI_Distress_100m_ChainageWise.xlsx'
OUT = r'c:\Users\Kunal.Desale\Downloads\ADANI-NEW\ADANI-NEW\Adani\src\assets\data\adani-reported.json'
PROJECT = 'ADANI-NANASA (NPRPL)'
SHEETS = [('Main Road', 'main'), ('Service Road', 'service')]
SEVERITY = {'good': 'Low', 'fair': 'Medium', 'poor': 'High'}


def num(v):
    if v is None or v == '':
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def as_date(v):
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d')
    s = str(v or '').strip()
    return s[:10] if len(s) >= 10 else None


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    records = []
    for sheet, road in SHEETS:
        ws = wb[sheet]
        rows = ws.iter_rows(values_only=True)
        header = [str(h or '').strip() for h in next(rows)]
        idx = {name: i for i, name in enumerate(header)}

        def cell(row, name):
            i = idx[name]
            return row[i] if i < len(row) else None

        for row in rows:
            if not row or not row[0]:
                continue
            start = num(cell(row, 'Chainage_Start (km)'))
            end = num(cell(row, 'Chainage_End (km)'))
            if start is None:
                continue
            status = str(cell(row, 'Status') or '').strip().lower()
            direction = str(cell(row, 'Direction') or '').strip()
            if direction.lower().startswith('inc'):
                direction = 'Increasing'
            elif direction.lower().startswith('dec'):
                direction = 'Decreasing'
            records.append({
                'project_name': PROJECT,
                'chainage_start': start,
                'chainage_end': end if end is not None else start,
                'direction': direction,
                'pavement_type': str(cell(row, 'Carriage Type') or '').strip() or 'Flexible',
                'lane': 'Service road' if road == 'service' else 'Main carriageway',
                'road': road,
                'distress_type': str(cell(row, 'Category') or '').strip() or 'Distress',
                'latitude': num(cell(row, 'Latitude')),
                'longitude': num(cell(row, 'Longitude')),
                'date': as_date(cell(row, 'Date')) or '2026-09-15',
                'severity': SEVERITY.get(status, 'Low'),
                'area': num(cell(row, 'Area_sqm')),
                'length': num(cell(row, 'Length_m')),
                'width': num(cell(row, 'Width_m_')),
                'depth': num(cell(row, 'Depth_mm_')),
                'image_url': '',
            })

    records.sort(key=lambda r: (r['road'], r['chainage_start'], r['direction'], r['distress_type']))
    dates = sorted({r['date'] for r in records if r['date']}, reverse=True)
    payload = {'projects_dates': {PROJECT: dates}, 'records': records}
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {len(records)} records to {OUT}')
    from collections import Counter
    print('road', Counter(r['road'] for r in records))
    print('severity', Counter(r['severity'] for r in records))
    print('type', Counter(r['distress_type'] for r in records))


if __name__ == '__main__':
    main()
