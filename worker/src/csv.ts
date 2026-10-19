/** Minimal RFC-4180-ish CSV interchange (port of backend/src/lib/stocksoft/csv.js). */

interface CsvRow {
  [key: string]: string;
}

export function parseCsv(text: unknown): CsvRow[] {
  const s = String(text ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const obj: CsvRow = {};
    header.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
    return obj;
  });
}

/** Serialise rows of objects to CSV using the union of keys (first row's order first). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

/** Map tolerant CSV headers onto the common product shape. */
export function rowsFromCsv(text: unknown): Record<string, unknown>[] {
  return parseCsv(text).map((r: Record<string, string>) => ({
    sku: r.sku || r.SKU || r.item_code || '',
    barcode: r.barcode || r.upc || r.ean || '',
    name: r.name || r.product_name || r.title || '',
    brand: r.brand || r.manufacturer || '',
    price: r.price != null && r.price !== '' ? Number(r.price) : r.rrp ? Number(r.rrp) : null,
    quantity:
      r.quantity != null && r.quantity !== '' ? Number(r.quantity) : r.stock != null ? Number(r.stock) : undefined,
  }));
}
