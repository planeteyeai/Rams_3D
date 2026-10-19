const svg = (children, extra = {}) => (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px]" {...extra} {...props}>
    {children}
  </svg>
)

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />, { strokeWidth: 2.4, className: 'h-3.5 w-3.5' })
export const IconMore = ({ className = '', ...p }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={`h-4 w-4 ${className}`} {...p}>
    <circle cx="6" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18" cy="12" r="1.7" />
  </svg>
)
export const IconRoad = svg(<><path d="M4 20h16" /><path d="M6 20 9 4h6l3 16" /><path d="M12 8v2M12 13v2" /></>)
export const IconInventory = svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>)
export const IconPms = svg(<><path d="M3 17h18M5 17 8 7h8l3 10M9 12h6" /><circle cx="8" cy="19" r="1.4" /><circle cx="16" cy="19" r="1.4" /></>)
export const IconBituminous = svg(<><path d="M3 16c2.5-3 5-3 7.5 0s5 3 7.5 0 5-3 7.5 0" /><path d="M3 10c2.5-3 5-3 7.5 0s5 3 7.5 0 5-3 7.5 0" /><path d="M4 20h16" /></>)
export const IconConcrete = svg(<><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 12h18M12 4v16M7.5 4v16M16.5 4v16" /></>)
export const IconCondition = svg(<><path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 13v-2M12 19h.01m-2-9 4-3" /></>)
export const IconReported = svg(<><path d="M8 3h8v4H8z" /><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 12h6M9 16h4" /></>)
export const IconTraffic = svg(<><rect x="4" y="9" width="16" height="7" rx="2" /><path d="M6 9 8 5h8l2 4" /><circle cx="8" cy="18" r="1.6" /><circle cx="16" cy="18" r="1.6" /></>)
export const IconPredicted = svg(<><path d="M4 18 10 10l4 4 6-8M15 6h5v5" /></>)
export const IconBack = svg(<path d="M15 6 9 12l6 6" />)
export const IconChevron = svg(<path d="m9 6 6 6-6 6" />)
export const IconSearch = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
export const IconArrow = svg(<path d="M5 12h14M13 6l6 6-6 6" />)
export const IconBell = svg(<><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3s3-2 3-9" /><path d="M10 21h4" /></>)
export const IconUser = svg(<><circle cx="12" cy="8" r="3.2" /><path d="M5 19c1.4-3 3.4-4.5 7-4.5S17.6 16 19 19" /></>)
export const IconMinus = svg(<path d="M5 12h14" />, { strokeWidth: 2.4, className: 'h-3.5 w-3.5' })
export const IconExpand = svg(<><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M20 15v5h-5" /></>)
export const IconCompress = svg(<><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /></>)
export const IconLayers = svg(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>)
export const IconMapPin = svg(<><path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z" /><circle cx="12" cy="10" r="2.2" /></>)
