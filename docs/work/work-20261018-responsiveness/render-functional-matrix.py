"""Render the adjacent reviewed JSON as a standalone, searchable HTML matrix."""
import json
from pathlib import Path

folder = Path(__file__).resolve().parent
data = json.loads((folder / 'feature-matrix.json').read_text(encoding='utf-8'))
template = (folder / 'functional-matrix.template.html').read_text(encoding='utf-8')
embedded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('&', '\\u0026')
(folder / 'functional-matrix.html').write_text(template.replace('__MATRIX_JSON__', embedded), encoding='utf-8')
print(f'Rendered {len(data["features"])} features: {folder / "functional-matrix.html"}')
