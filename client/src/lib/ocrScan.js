// Reading a scanned purchase order in the planner's own browser.
//
// Some customer POs arrive with no text layer at all — every glyph is a filled
// vector outline, so pdfjs extracts zero characters and the import used to stop
// dead. They are not photographs though: rendered, they are perfectly crisp,
// which makes them an easy OCR target. Measured on the two on file, the engine
// returns every business figure exactly — 290 digits, no errors — and all five
// line items reconcile against the amounts the documents print.
//
// This runs in the BROWSER on purpose. Rendering a page needs a canvas, which
// on Vercel would mean a native dependency, and recognising three A4 pages runs
// well past the serverless function's 30-second ceiling. The planner's machine
// has both, for free, and nothing has to be uploaded but the words.
//
// Nothing here interprets the page. The word boxes go to the server, which runs
// the same table reader a digital PO goes through, so a scan and its digital
// twin cannot be read differently.

// 300 DPI on a 72pt page. Measured against 150/200/300/400/600: everything from
// 150 up reads the digits identically, and past 300 the canvas grows quadratically
// for nothing — an A4 page is already 2481x3509 and ~35MB here.
export const RENDER_SCALE = 300 / 72;

const TESS_PATHS = {
  workerPath: '/tesseract/worker.min.js',
  // A directory, not a file: tesseract.js probes for wasm SIMD and appends the
  // core filename itself. (Ending this string in "js" would pin one build.)
  corePath: '/tesseract',
  langPath: '/tessdata',
};

let pdfjsPromise;
// Loaded on demand — pdfjs and the OCR engine together are megabytes, and most
// POs are digital and never need either.
async function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}

// tesseract's word -> the shape the server expects. Symbols come too: the
// server needs them to split a token the engine welded across a cell boundary,
// and without them a quantity can be lost into the unit column.
const toWord = w => ({
  text: w.text,
  x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
  conf: w.confidence,
  symbols: (w.symbols || []).map(s => ({
    t: s.text, x0: s.bbox.x0, y0: s.bbox.y0, x1: s.bbox.x1, y1: s.bbox.y1,
  })),
});

function collectWords(data) {
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const w of l.words || []) if (String(w.text || '').trim()) out.push(toWord(w));
      }
    }
  }
  return out;
}

/**
 * Render and recognise every page of a PDF.
 * @param {ArrayBuffer} buffer the PDF
 * @param {(p:{page:number,pages:number,phase:string})=>void} [onProgress]
 * @returns {Promise<{pages:Array}>} the payload for POST /orders/import/parse-ocr
 */
export async function ocrPdf(buffer, onProgress = () => {}) {
  const [pdfjs, tesseract] = await Promise.all([loadPdfjs(), import('tesseract.js')]);
  const { createWorker, PSM, OEM } = tesseract;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const worker = await createWorker('eng', OEM.LSTM_ONLY, TESS_PATHS);
  try {
    // The default page-segmentation mode is SINGLE_BLOCK, which on a ruled table
    // reads the whole grid as one block and glues neighbouring cells together.
    // AUTO is what keeps the columns apart.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress({ page: n, pages: doc.numPages, phase: 'rendering' });
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      // These pages are drawn on transparent ground; without a white fill the
      // text is rendered onto black and the engine reads almost nothing.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

      onProgress({ page: n, pages: doc.numPages, phase: 'reading' });
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      pages.push({
        page: n,
        scale: RENDER_SCALE,
        width_px: canvas.width,
        height_px: canvas.height,
        words: collectWords(data),
      });

      // An A4 page at this scale is ~35MB of pixels. Let each one go before
      // rendering the next, or a long PO walks the tab into a memory ceiling.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
    return { pages };
  } finally {
    await worker.terminate();
    doc.destroy?.();
  }
}
