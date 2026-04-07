import { useState, useRef, useCallback } from 'react'
import { useUIStore } from '../stores/ui'

const YT_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/

export default function SearchBar() {
  const [value, setValue] = useState('')
  const setSearch = useUIStore(s => s.setSearch)
  const setTab = useUIStore(s => s.setTab)
  const addToast = useUIStore(s => s.addToast)
  const timerRef = useRef(null)

  const handleSubmit = useCallback((query) => {
    const q = query.trim()
    if (!q) return

    // Check if it's a YouTube URL — auto-play it
    const match = q.match(YT_URL_RE)
    if (match) {
      const url = q.includes('http') ? q : `https://www.youtube.com/watch?v=${match[1]}`
      fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).then(() => {
        addToast('Playing URL')
        setValue('')
      }).catch(() => addToast('Play failed'))
      return
    }

    setSearch(q)
    setTab('search')
  }, [setSearch, setTab, addToast])

  const handleChange = (e) => {
    const v = e.target.value
    setValue(v)

    // Auto-detect pasted YouTube URL
    const match = v.match(YT_URL_RE)
    if (match && v.startsWith('http')) {
      handleSubmit(v)
      return
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(value)
    }
  }

  const handleClear = () => {
    setValue('')
    setSearch('')
    setTab('home')
  }

  return (
    <div className="search-wrap">
      <input
        className="search-input"
        type="text"
        placeholder="Search"
        autoComplete="off"
        enterKeyHint="search"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {value && (
        <button className="search-clear" onClick={handleClear}>
          &times;
        </button>
      )}
    </div>
  )
}
