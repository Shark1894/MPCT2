// Time tracking (Stats tab), without the browser: counts active seconds per stretch of one
// activity. The page calls tick() every second with whether it's visible and what you're doing,
// and input() whenever you touch it; time counts only while the page is visible and you've
// touched it within the last IDLE_MS. A stretch ends when the activity changes, the local day
// changes, or you come back after being idle, so each stretch belongs to one day and one thing.

export const IDLE_MS = 2 * 60 * 1000;
const MAX_STEP_MS = 5000; // a longer gap between ticks (a sleeping laptop, a throttled tab) isn't counted

/** {category, activity, detail} → a string that's equal for the same activity. */
export function activityId(a) {
  return a ? `${a.category}|${a.activity}|${a.detail ?? ''}` : '';
}

export class TimeTracker {
  /**
   * @param {object} deps
   * @param {() => string} deps.uuid   a new stretch key
   * @param {(t: number) => string} [deps.day]  local day of a time (ends stretches at midnight)
   * @param {number} [deps.idleMs]
   */
  constructor({ uuid, day = (t) => new Date(t).toDateString(), idleMs = IDLE_MS }) {
    this.uuid = uuid;
    this.day = day;
    this.idleMs = idleMs;
    this.current = null; // {key, category, activity, detail, started_at, seconds, sent, lastCounted, day}
    this.lastTick = null;
    this.lastInput = -Infinity;
  }

  input(t) {
    this.lastInput = t;
  }

  /**
   * One step of the clock. Returns the stretches that ended (to be sent).
   * @param {number} t now (ms)
   * @param {boolean} visible
   * @param {{category: string, activity: string, detail?: string|null}|null} activity what's on screen (null: nothing counted)
   */
  tick(t, visible, activity) {
    const ended = [];
    const step = this.lastTick === null ? 0 : Math.min(Math.max(t - this.lastTick, 0), MAX_STEP_MS);
    this.lastTick = t;
    const active = Boolean(visible && activity && t - this.lastInput <= this.idleMs);
    if (!active) return ended;
    const cur = this.current;
    const stale =
      cur &&
      (activityId(cur) !== activityId(activity) || this.day(t) !== cur.day || t - cur.lastCounted > this.idleMs + MAX_STEP_MS);
    if (cur && stale) {
      ended.push(this._snapshot());
      this.current = null;
    }
    if (!this.current) {
      this.current = {
        key: this.uuid(),
        category: activity.category,
        activity: activity.activity,
        detail: activity.detail ?? null,
        started_at: new Date(t).toISOString(),
        seconds: 0,
        sent: 0,
        lastCounted: t,
        day: this.day(t),
      };
      return ended.filter((s) => s.seconds > 0);
    }
    this.current.seconds += step / 1000;
    this.current.lastCounted = t;
    return ended.filter((s) => s.seconds > 0);
  }

  /** The open stretch, if it has time not yet sent (marks it sent). */
  pending() {
    const cur = this.current;
    if (!cur || cur.seconds < 1 || cur.seconds - cur.sent < 1) return null;
    cur.sent = cur.seconds;
    return this._snapshot();
  }

  _snapshot() {
    const c = this.current;
    return {
      key: c.key,
      category: c.category,
      activity: c.activity,
      detail: c.detail,
      started_at: c.started_at,
      seconds: Math.round(c.seconds * 10) / 10,
    };
  }
}
