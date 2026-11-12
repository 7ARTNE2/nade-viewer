// Freeze the radar before awaiting SVG decoding so playback cannot change the frame.
export async function captureReplayScreenshot(
  canvas: HTMLCanvasElement,
  annotations: SVGSVGElement | null,
): Promise<string> {
  if (!canvas.width || !canvas.height) throw new Error('Radar is not ready');
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext('2d');
  if (!context) throw new Error('Unable to create screenshot');
  context.drawImage(canvas, 0, 0);
  if (annotations?.childElementCount) {
    const bounds = annotations.getBoundingClientRect();
    const svg = annotations.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(bounds.width));
    svg.setAttribute('height', String(bounds.height));
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    context.drawImage(image, 0, 0, snapshot.width, snapshot.height);
  }
  return snapshot.toDataURL('image/png');
}

export function screenshotBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(dataUrl.split(',')[1]), (char) =>
    char.charCodeAt(0),
  );
}
