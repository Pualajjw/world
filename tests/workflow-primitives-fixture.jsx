import React from 'react'
import { createPortal } from 'react-dom'

/** Native chrome stand-in only; the workflow editor, graph and ReactFlow remain real. */
export function Modal({ open, title, closeLabel, onClose, children, className, contentClassName }) {
  return open ? createPortal(<div><section role="dialog" aria-label={title} className={className}>
    <button onClick={onClose} aria-label={closeLabel}>关闭</button><div className={contentClassName}>{children}</div>
  </section></div>, document.body) : null
}
