/** Phone presentation never overwrites the saved desktop geometry. */
export const PHONE_BREAKPOINT = 600

export function isPhoneViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= PHONE_BREAKPOINT
}

export function fitSavedDesktopRect(rect, clamp) {
  return isPhoneViewport() && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect?.[key]))
    ? rect : clamp(rect)
}
