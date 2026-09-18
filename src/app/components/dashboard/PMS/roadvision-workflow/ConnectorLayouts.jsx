import { useCallback, useEffect, useId, useRef, useState } from 'react'

const STROKE = '#4338CA'
const curve = (a, b) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}
const pt = (el, wrap, side) => {
  const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect()
  return { x: (side === 'right' ? r.right : r.left) - w.left, y: r.top + r.height / 2 - w.top }
}

function useConnectors(measure, deps) {
  const wrapRef = useRef(null)
  const [lines, setLines] = useState([])
  const [box, setBox] = useState({ width: 1, height: 1 })
  const markerId = useId().replace(/:/g, '')
  const update = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    setLines(measure(wrap) || [])
    setBox({ width: wrap.offsetWidth, height: wrap.offsetHeight })
  }, [measure])

  useEffect(() => {
    update()
    const wrap = wrapRef.current
    if (!wrap) return
    const ob = new ResizeObserver(update)
    ob.observe(wrap)
    window.addEventListener('resize', update)
    return () => { ob.disconnect(); window.removeEventListener('resize', update) }
  }, [update, ...deps])

  return { wrapRef, lines, box, markerId }
}

function ConnectorSvg({ box, id, lines }) {
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${box.width || 1} ${box.height || 1}`} aria-hidden>
      <defs>
        <marker id={id} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0 0.6 L7.5 4 L0 7.4" fill="none" stroke={STROKE} strokeWidth="1.4" />
        </marker>
      </defs>
      {lines.map((line, i) => <path key={i} d={curve(line.a, line.b)} fill="none" stroke={STROKE} strokeWidth="1.7" markerEnd={`url(#${id})`} />)}
    </svg>
  )
}

export function BranchLayout({ origin, children }) {
  const originRef = useRef(null)
  const childRefs = useRef([])
  const measure = useCallback((wrap) => {
    if (!originRef.current) return []
    const a = pt(originRef.current, wrap, 'right')
    return childRefs.current.filter(Boolean).map((el) => ({ a, b: pt(el, wrap, 'left') }))
  }, [])
  const { wrapRef, lines, box, markerId } = useConnectors(measure, [children])

  return (
    <div ref={wrapRef} className="relative grid h-full min-h-0 grid-cols-1 items-center gap-8 overflow-hidden md:grid-cols-[minmax(220px,280px)_minmax(240px,1fr)] md:gap-16">
      <ConnectorSvg box={box} id={`arrow-${markerId}`} lines={lines} />
      <div ref={originRef} className="flex justify-center md:justify-start">{origin}</div>
      <div className="flex flex-col items-center justify-center gap-3 md:items-start">
        {children.map((child, i) => (
          <div key={child.key || i} ref={(el) => { childRefs.current[i] = el }}>{child}</div>
        ))}
      </div>
    </div>
  )
}

export function GraphLayout({ className, links, children }) {
  const refs = useRef({})
  const measure = useCallback((wrap) => links.flatMap(([from, to]) => {
    const a = refs.current[from], b = refs.current[to]
    return a && b ? [{ a: pt(a, wrap, 'right'), b: pt(b, wrap, 'left') }] : []
  }), [links])
  const { wrapRef, lines, box, markerId } = useConnectors(measure, [links, children])
  const bind = (id) => (el) => { refs.current[id] = el }

  return (
    <div ref={wrapRef} className={className}>
      <ConnectorSvg box={box} id={`graph-${markerId}`} lines={lines} />
      {children(bind)}
    </div>
  )
}

export function SequenceLayout({ nodes }) {
  const nodeRefs = useRef([])
  const measure = useCallback((wrap) => {
    const els = nodeRefs.current.filter(Boolean)
    return els.slice(0, -1).map((el, i) => ({ a: pt(el, wrap, 'right'), b: pt(els[i + 1], wrap, 'left') }))
  }, [])
  const { wrapRef, lines, box, markerId } = useConnectors(measure, [nodes])

  return (
    <div ref={wrapRef} className="relative flex h-full min-h-0 items-center justify-center gap-10 overflow-hidden px-1 py-3">
      <ConnectorSvg box={box} id={`seq-${markerId}`} lines={lines} />
      {nodes.map((node, i) => (
        <div key={node.key || i} className="relative z-[1]" ref={(el) => { nodeRefs.current[i] = el }}>{node}</div>
      ))}
    </div>
  )
}
