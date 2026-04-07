import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/ui'

function ToastItem({ msg }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Trigger the show animation after mount
    requestAnimationFrame(() => setShow(true))
  }, [])

  return (
    <div className={`toast${show ? ' show' : ''}`}>
      {msg}
    </div>
  )
}

export default function Toast() {
  const toasts = useUIStore(s => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <ToastItem key={t.id} msg={t.msg} />
      ))}
    </div>
  )
}
