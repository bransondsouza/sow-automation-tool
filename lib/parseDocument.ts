import mammoth from "mammoth";

// pdf-parse is CommonJS and reads a debug sample file if imported the wrong
// way in some bundlers; importing the module entrypoint directly (as done
// here) and calling it as a function avoids that entirely.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse");

/**
 * Extracts plain text from an uploaded SOW file.
 * Supports PDF (.pdf) and Word (.docx) only, per the spec.
 */
export async function extractTextFromFile(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const lower = filename.toLowerCase();

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    const result = await pdfParse(buffer);
    if (!result.text || result.text.trim().length < 20) {
      throw new Error(
        "Couldn't read any text from this PDF. If it's a scanned image, please upload a text-based PDF or the original Word file."
      );
    }
    return result.text;
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  throw new Error(
    "Unsupported file type. Please upload a PDF (.pdf) or Word document (.docx)."
  );
}
