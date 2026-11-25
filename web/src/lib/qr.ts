function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Firefox will not draw an SVG without a fixed size, and the server sends one that scales. */
export function sized(svg: string, size: number): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') throw new Error('not an SVG');
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  return new XMLSerializer().serializeToString(doc);
}
export const svgUrl = (svg: string): string => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));

export function downloadSvg(svg: string, name: string): void {
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
}

export async function downloadPng(svg: string, name: string, size = 1024): Promise<void> {
  const url = svgUrl(sized(svg, size));
  try {
    const img = new Image(size, size);
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
    if (!blob) throw new Error('no image');
    download(blob, `${name}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
