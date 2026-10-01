// Basic consent mode: no Google request until the visitor opts in.
const measurementId = 'G-PDC9Z8T1LC'
const consentKey = 'fluidlab.analytics-consent.v1'
const productionOrigin = 'https://fluidlab.fly.dev'

type AnalyticsWindow = Window & {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
  [key: `ga-disable-${string}`]: boolean
}

export function initAnalytics() {
  if (!import.meta.env.PROD || location.origin !== productionOrigin) return
  if (document.getElementById('analytics-preferences')) return
  const win = window as unknown as AnalyticsWindow
  let started = false
  let choice: string | null = null
  try { choice = localStorage.getItem(consentKey) } catch { /* storage may be blocked */ }
  const optedOut = navigator.doNotTrack === '1' ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true

  function start() {
    if (optedOut) return
    win[`ga-disable-${measurementId}`] = false
    if (started) return
    started = true
    win.dataLayer = win.dataLayer || []
    // gtag requires an arguments object, rather than an array, in the data layer.
    win.gtag = function () { win.dataLayer!.push(arguments) }
    win.gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
    })
    win.gtag('consent', 'update', { analytics_storage: 'granted' })
    // Fixed values prevent project names, routes, query strings, hashes and
    // referrers from entering both page_view and automatic session events.
    win.gtag('set', {
      page_location: productionOrigin + '/', page_title: 'FluidLab', page_referrer: '',
      allow_google_signals: false, allow_ad_personalization_signals: false,
      campaign_id: '', campaign_name: '', campaign_source: '', campaign_medium: '',
      campaign_term: '', campaign_content: '',
    })
    win.gtag('js', new Date())
    win.gtag('config', measurementId, {
      send_page_view: false, cookie_domain: 'fluidlab.fly.dev',
      cookie_expires: 60 * 60 * 24 * 90, cookie_flags: 'SameSite=Lax;Secure',
      allow_google_signals: false, allow_ad_personalization_signals: false,
    })
    win.gtag('event', 'page_view', { send_to: measurementId })
    const script = document.createElement('script')
    script.async = true
    script.referrerPolicy = 'no-referrer'
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId
    document.head.append(script)
  }

  const preferences = document.createElement('button')
  preferences.id = 'analytics-preferences'
  preferences.textContent = 'Privacy'
  preferences.className = 'analytics-preferences'
  const panel = document.createElement('section')
  panel.className = 'analytics-consent'
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', 'Optional visitor analytics')
  const message = document.createElement('p')
  message.textContent = optedOut
    ? 'Your browser privacy preference is respected. Visitor analytics is off.'
    : 'Allow optional Google Analytics cookies to count visits and returning browsers? Google receives basic browser and visit information. Your rigs, files, inputs and share links are not included. You can change this choice here anytime.'
  const link = document.createElement('a')
  link.href = 'https://policies.google.com/privacy'
  link.textContent = 'Google privacy policy'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  panel.append(message, link)

  function choose(value: 'granted' | 'denied') {
    choice = value
    try { localStorage.setItem(consentKey, value) } catch { /* session-only choice */ }
    panel.hidden = true
    if (value === 'granted') start()
    else {
      // Stop collection before deleting identifiers; do not send a denied ping.
      win[`ga-disable-${measurementId}`] = true
      for (const cookie of document.cookie.split(';')) {
        const name = cookie.trim().split('=')[0]
        if (name === '_ga' || name.startsWith('_ga_')) {
          for (const domain of ['', ';domain=fluidlab.fly.dev', ';domain=.fluidlab.fly.dev']) {
            document.cookie = `${name}=;max-age=0;path=/${domain};SameSite=Lax;Secure`
          }
        }
      }
    }
  }

  for (const [text, value] of [['Decline', 'denied'], ['Allow analytics', 'granted']] as const) {
    const button = document.createElement('button')
    button.textContent = text
    button.disabled = optedOut && value === 'granted'
    button.onclick = () => choose(value)
    panel.append(button)
  }
  preferences.onclick = () => { panel.hidden = !panel.hidden }
  panel.hidden = choice !== null || optedOut
  document.body.append(preferences, panel)
  if (choice === 'granted' && !optedOut) start()
  if (optedOut) choose('denied')
}
