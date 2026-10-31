/** Authored operator glyphs; no imported markup or remote assets. */
const PATHS = {
  reply: ['M5 5h22v16H15l-6 6v-6H5z','M10 10h12M10 15h8'],
  step: ['M5 7h8v6H5zM19 19h8v6h-8z','M9 13v9h10M13 10h10v9'],
  file: ['M9 3h10l6 6v20H9z','M19 3v7h6M13 15h8M13 19h8M13 23h5'],
  http: ['M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0z','M4 16h24M16 4c-7 7-7 17 0 24M16 4c7 7 7 17 0 24'],
  merge: ['M5 5v6l9 5-9 5v6M27 5v6l-9 5 9 5v6','M10 16h12'],
  calculate: ['M7 3h18v26H7z','M11 7h10v5H11zM11 17h2M19 17h2M11 22h2M19 22h2'],
  tool: ['M5 7h22v19H5z','M5 12h22M10 16l4 3-4 3M17 22h5'],
  claim: ['M16 3l11 5v8c0 7-11 13-11 13S5 23 5 16V8z','M11 16l4 4 7-8'],
  evidence: ['M12 19l-3 3a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 0','M20 13l3-3a5 5 0 0 1 7 7l-6 6a5 5 0 0 1-7 0M11 21l10-10'],
  missing: ['M16 4L30 28H2z','M16 12v7M16 23v1']
};
export function operatorIcon(kind, reference) {
  const glyph = kind === 'source' ? (reference?.kind === 'http' ? 'http' : 'file')
    : kind === 'tool' ? (/read/.test(reference?.toolName ?? '') ? 'file' : /web|http/.test(reference?.toolName ?? '') ? 'http' : /calcul/.test(reference?.toolName ?? '') ? 'calculate' : reference?.toolName === 'run_code' ? 'merge' : 'tool') : kind;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  for(const [key,value]of Object.entries({viewBox:'0 0 32 32',width:32,height:32,fill:'none',stroke:'currentColor','stroke-width':1.6,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,String(value));
  for(const d of PATHS[glyph] ?? PATHS.tool){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);svg.append(p);}
  return svg;
}
