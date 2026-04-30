import { useEffect } from 'react'
import { useSyncStore } from '../stores/sync'

// Top-of-screen "kill feed" of Claude pane output. Each line streams
// in from /ws/sync (claude-feed message), shows for ~5s with a fade,
// then drops off. Hidden while the terminal panel is open — the user
// is reading it directly there. Pointer-events: none so it never
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
        <div key={l.id} className="claude-feed-line">{l.text}</div>
      ))}
    </div>
  )
}
