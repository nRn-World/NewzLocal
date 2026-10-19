import type { Article } from './lib'
import { hotWords, topicCounts } from './topics'

type T = (k: string, v?: Record<string, string>) => string

/** Topic chips with counts; the line above them says what the place is about right now. */
export function TopicBar({ articles, topic, setTopic, t }: { articles: Article[]; topic: string; setTopic: (t: string) => void; t: T }) {
  const counts = topicCounts(articles)
  if (counts.length === 0) return null
  return (
    <div className="topics">
      <p className="sumline">{t('sumNow')} {counts.slice(0, 3).map(([id, n]) => `${n} ${t('t' + id).toLowerCase()}`).join(' · ')}</p>
      <div className="chips">
        <button className={!topic ? 'chip on' : 'chip'} onClick={() => setTopic('')}>{t('tAll')} ({articles.length})</button>
        {counts.map(([id, n]) => <button key={id} className={topic === id ? 'chip on' : 'chip'} onClick={() => setTopic(topic === id ? '' : id)}>{t('t' + id)} ({n})</button>)}
      </div>
    </div>
  )
}

/** A short report on how busy the place is, built only from the headlines already loaded. */
export function Report({ articles, scope, areas, t }: { articles: Article[]; scope: string; areas: { name: string; n: number }[]; t: T }) {
  if (articles.length < 3) return null
  const now = Date.now()
  const WEEK = 7 * 864e5
  const n7 = articles.filter((a) => now - +a.date < WEEK).length
  const oldest = Math.min(...articles.map((a) => +a.date))
  const weeks = (now - oldest) / WEEK
  const usual = weeks > 1.5 ? articles.length / weeks : undefined // only meaningful when the list reaches back more than a week
  const verdict = usual === undefined ? '' : n7 > usual * 1.3 ? t('repAbove') : n7 < usual * 0.7 ? t('repBelow') : t('repNormal')
  const topics = topicCounts(articles).slice(0, 3)
  const words = hotWords(articles, scope)
  const hot = areas.filter((a) => a.n > 0).sort((a, b) => b.n - a.n).slice(0, 3)
  return (
    <details className="report">
      <summary>{t('report')}</summary>
      <p><b>{t('repWeek', { n: String(n7) })}</b>{usual !== undefined && ` (${t('repUsual', { n: usual.toFixed(1) })})`}</p>
      {verdict && <p className="verdict">{verdict}</p>}
      {topics.length > 0 && <p>{topics.map(([id, n]) => `${t('t' + id)} ${n}`).join(' · ')}</p>}
      {words.length > 0 && <p><i>{t('repTop')}:</i> {words.map(([w, n]) => `${w} (${n})`).join(', ')}</p>}
      {hot.length > 0 && <p><i>{t('repHot')}:</i> {hot.map((a) => `${a.name} (${a.n})`).join(', ')}</p>}
    </details>
  )
}

const STEPS = [0, 1, 3, 6, 12] // months back
const KEYS = ['tNow', 't1m', 't3m', 't6m', 't1y']

/** Slider to look at the news from around a month ago (one year at most). */
export function TimeTravel({ months, setMonths, t }: { months: number; setMonths: (m: number) => void; t: T }) {
  const i = Math.max(0, STEPS.indexOf(months))
  return (
    <label className="time">
      <span>{t('timeTravel')}: <b>{t(KEYS[i])}</b></span>
      <input type="range" min={0} max={STEPS.length - 1} step={1} value={i} onChange={(e) => setMonths(STEPS[Number(e.target.value)])} aria-label={t('timeTravel')} />
    </label>
  )
}
