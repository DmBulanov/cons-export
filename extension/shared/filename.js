/** Sanitize a document title into a safe Windows/macOS filename. */
function consSafeFilename(title, index, ext) {
  let name = String(title || "document")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!name) name = "document";
  const num = index != null ? String(index).padStart(2, "0") + " - " : "";
  return `${num}${name}.${ext.replace(/^\./, "")}`;
}

if (typeof globalThis !== "undefined") {
  globalThis.consSafeFilename = consSafeFilename;
}
