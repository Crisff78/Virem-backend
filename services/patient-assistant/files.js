const sharp = require("sharp");
const { MAX_BYTES, fail, extractionSchema } = require("./contracts");

// Adapted from Korthyx sniffAttachmentMime; complete signatures and decoding are required here.
function sniff(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}
async function validateFile(buffer) {
  if (!buffer?.length) fail("invalid_file");
  if (buffer.length > MAX_BYTES) fail("file_too_large", 413);
  const mime = sniff(buffer);
  if (!mime) fail("invalid_file");
  if (mime !== "application/pdf") {
    try {
      const image = sharp(buffer, {
        limitInputPixels: 25000000,
        failOn: "warning",
      });
      const meta = await image.metadata();
      if ((meta.pages || 1) !== 1) fail("invalid_file");
      await image.stats(); // Decode pixels, not only headers. No lossy resize of medical values.
    } catch {
      fail("invalid_file");
    }
    return { mime, pages: [] };
  }
  let task;
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    task = getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      verbosity: 0,
      useSystemFonts: false,
      stopAtErrors: true,
      disableFontFace: true,
    });
    const pdf = await task.promise;
    if (pdf.numPages > 20) fail("page_limit");
    const pages = [];
    let size = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || "").join(" ");
      size += text.length;
      if (size > 100000) fail("unreadable");
      pages.push(text);
    }
    return { mime, pages };
  } catch (error) {
    if (error.code === "page_limit" || error.code === "unreadable") throw error;
    fail("invalid_file");
  } finally {
    if (task) await task.destroy();
  }
}
// Whole-token match: "10" does not match inside "100" or "0,10", while units may be
// attached to numbers ("90mg/dL").
function containsLiteral(text, literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = (char, digit, letter) =>
    /\p{N}/u.test(char) ? digit : /\p{L}/u.test(char) ? letter : "";
  const left = edge(literal[0], "(^|[^\\p{N}.,])", "(^|[^\\p{L}])");
  const right = edge(literal.at(-1), "($|[^\\p{N}.,]|[.,](?!\\p{N}))", "($|[^\\p{L}])");
  return new RegExp(left + escaped + right, "u").test(text);
}
function verifiedExtraction(raw, pages) {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) fail("unreadable", 422);
  const value = parsed.data;
  if (value.kind === "unsupported") fail("unsupported", 422);
  if (value.kind === "unreadable" || !value.text.trim())
    fail("unreadable", 422);
  const normalized = (s) => s.replace(/\s+/g, " ").trim();
  // Text layer of the whole PDF; empty for images and scanned PDFs.
  const fullText = normalized(pages.join(" ")).toLowerCase();
  value.findings = value.findings.map((f) => {
    const source = f.page && pages[f.page - 1];
    const quote = normalized(f.quote);
    const cited =
      source &&
      quote.length >= 8 &&
      normalized(source).includes(quote) &&
      [f.label, f.value, f.unit, f.range]
        .filter(Boolean)
        .every((v) => quote.includes(normalized(v)));
    // verified: true = value, unit and range appear literally in the text layer;
    // false = they do not; null = there is no text layer or no value to compare.
    const literals = [f.value, f.unit, f.range].map(normalized).filter(Boolean);
    const verified = cited
      ? true
      : !fullText || !literals.length
        ? null
        : literals.every((v) => containsLiteral(fullText, v.toLowerCase()));
    return {
      ...f,
      page: cited ? f.page : null,
      quote: cited ? f.quote : "",
      verified,
    };
  });
  return value;
}
async function validateAudio(buffer) {
  if (!buffer?.length || buffer.length > MAX_BYTES) fail("invalid_audio");
  try {
    const { parseBuffer } = await import("music-metadata");
    const metadata = await parseBuffer(
      buffer,
      { size: buffer.length },
      { duration: true },
    );
    const duration = metadata.format.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120.5)
      fail("invalid_audio");
    const container = metadata.format.container || "";
    const format = /WebM|Matroska/i.test(container)
      ? ["audio/webm", "webm"]
      : /MPEG-4|M4A|isom|mp4/i.test(container)
        ? ["audio/mp4", "m4a"]
        : /Ogg/i.test(container)
          ? ["audio/ogg", "ogg"]
          : /WAVE/i.test(container)
            ? ["audio/wav", "wav"]
            : null;
    if (!format) fail("invalid_audio");
    return { mime: format[0], extension: format[1] };
  } catch {
    fail("invalid_audio");
  }
}
module.exports = { sniff, validateFile, verifiedExtraction, validateAudio };
