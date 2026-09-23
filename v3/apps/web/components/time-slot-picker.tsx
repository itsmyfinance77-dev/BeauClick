import { formatShortDate, toPersianDigits } from '@beauclick/persian-utils';
import { slotTimeLabel, type AvailableSlot } from '@/lib/booking-api';
import styles from './time-slot-picker.module.css';

/**
 * Pick a day, then a time — `V3_COMPONENT_INVENTORY.md`'s `TimeSlotPicker`,
 * `02_PROVIDER_PROFILE.md`.
 *
 * Four days at a time, which is what the strip's four-column grid holds. The
 * count under each day («۳ زمان») is a fact from the same response that
 * produced the slots, not a promise about availability later.
 *
 * `onSelectDay` carries the obligation to clear the chosen time as well: a
 * time from the previous day is not on the new one, and leaving it selected
 * would let a customer confirm a slot the strip no longer shows. The page owns
 * both pieces of state, so it does the clearing; this component only reports
 * the choice.
 *
 * `SlotDay` is the shape `groupSlotsByDay` returns.
 */
/** What the strip's four-column grid holds without wrapping. */
const DAYS_SHOWN = 4;

export interface SlotDay {
  dayKey: string;
  date: Date;
  slots: AvailableSlot[];
}

export function TimeSlotPicker({
  days,
  activeDay,
  selectedSlotId,
  onSelectDay,
  onSelectSlot,
}: {
  days: SlotDay[];
  activeDay: SlotDay | null;
  selectedSlotId: string | null;
  onSelectDay: (dayKey: string) => void;
  onSelectSlot: (slotId: string) => void;
}) {
  return (
    <>
      <div className={styles.dayStrip} data-testid="day-strip">
        {days.slice(0, DAYS_SHOWN).map((day) => {
          const chosen = activeDay?.dayKey === day.dayKey;
          const parts = formatShortDate(day.date);
          return (
            <button
              key={day.dayKey}
              type="button"
              className={`${styles.day} ${chosen ? styles.dayChosen : ''}`}
              aria-pressed={chosen}
              data-day={day.dayKey}
              onClick={() => onSelectDay(day.dayKey)}
            >
              <span className={styles.dayWeekday}>{parts.weekday}</span>
              <span className={styles.dayNumber}>{parts.day}</span>
              <span className={styles.dayCount}>{toPersianDigits(day.slots.length)} زمان</span>
            </button>
          );
        })}
      </div>

      <div className={styles.slotGrid} data-testid="slot-grid">
        {(activeDay?.slots ?? []).map((slot) => {
          const chosen = slot.id === selectedSlotId;
          return (
            <button
              key={slot.id}
              type="button"
              className={`${styles.slot} ${chosen ? styles.slotChosen : ''}`}
              aria-pressed={chosen}
              data-slot={slot.id}
              onClick={() => onSelectSlot(slot.id)}
            >
              {slotTimeLabel(slot.startAt)}
            </button>
          );
        })}
      </div>
    </>
  );
}
