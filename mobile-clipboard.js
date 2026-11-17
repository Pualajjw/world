/** Clipboard API on secure pages, with a selection-based fallback for LAN HTTP and desktop shells. */
export async function copyMobileAddress(text, container = document.body) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* LAN HTTP and some desktop shells do not expose the clipboard API. */ }
  const previous = document.activeElement, selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  let area
  try {
    area = document.createElement('textarea')
    area.value = text; area.readOnly = true
    area.style.cssText = 'position:fixed;left:-9999px;top:0'
    container.append(area)
    area.focus({ preventScroll: true }); area.select(); area.setSelectionRange(0, text.length)
    return document.execCommand('copy') === true
  } catch { return false }
  finally {
    area?.remove()
    if (previous?.isConnected) previous.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
  }
}
