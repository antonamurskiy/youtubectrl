import { useEffect, useRef, useState } from 'react'
import { useSyncStore } from '../stores/sync'

// Each line measures its rendered height after mount and pins it
// as a CSS custom property. The collapse phase of the fade animation
// animates `max-height` from that real value down to 0, so the
// column slides up smoothly instead of holding its size until the
// last 10% of the animation (which was the case when max-height
// was a generous 240px and most bubbles only ~30px tall).
function FeedLine({ line }) {
  const ref = useRef(null)
  const [styleVar, setStyleVar] = useState(null)
  useEffect(() => {
    if (!ref.current) return
    const h = ref.current.getBoundingClientRect().height
    if (h > 0) setStyleVar({ '--init-h': `${Math.ceil(h)}px` })
  }, [])
  return (
    <div ref={ref} className="claude-feed-line" style={styleVar}>{line.text}</div>
  )
}

// Top-of-screen "kill feed" of Claude pane output. Each line streams
// in from /ws/sync (claude-feed message), shows briefly then fades +
// collapses. Hidden while the terminal panel is open — the user is
// reading it directly there. Pointer-events: none so it never
// intercepts taps on the video grid behind it.
export default function ClaudeFeed() {
  const lines = useSyncStore((s) => s.claudeFeed)
  const terminalOpen = useSyncStore((s) => s.terminalOpen)
  const pruneClaudeFeed = useSyncStore((s) => s.pruneClaudeFeed)

  useEffect(() => {
    const id = setInterval(pruneClaudeFeed, 500)
    return () => clearInterval(id)
  }, [pruneClaudeFeed])

  if (terminalOpen) return null
  if (!lines.length) return null

  return (
    <div className="claude-feed">
      {lines.map((l) => (
        <FeedLine key={l.id} line={l} />
      ))}
    </div>
  )
}
