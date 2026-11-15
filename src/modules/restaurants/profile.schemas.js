import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const MAX_RANGES_PER_DAY = 3;
const DAY_MINUTES = 24 * 60;

const time = z
  .string({ error: "Time must be HH:MM" })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// A close earlier than the open means the range runs past midnight.
const range = z
  .object({ open: time, close: time })
  .refine((r) => r.open !== r.close, { message: "Opening and closing time must differ", path: ["close"] });

const day = z
  .array(range)
  .max(MAX_RANGES_PER_DAY, `At most ${MAX_RANGES_PER_DAY} opening times a day`)
  .default([]);

// [start, end) in minutes of the day; a range past midnight is cut at
// midnight and the rest belongs to the next day.
const ownSpans = (ranges) =>
  ranges.map(({ open, close }) => [minutes(open), minutes(close) > minutes(open) ? minutes(close) : DAY_MINUTES]);
const spillSpans = (ranges) =>
  ranges.filter(({ open, close }) => minutes(close) < minutes(open)).map(({ close }) => [0, minutes(close)]);

const overlaps = (spans) => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  return sorted.some((span, i) => i > 0 && span[0] < sorted[i - 1][1]);
};

const openingHours = z
  .object(Object.fromEntries(WEEKDAYS.map((name) => [name, day])))
  .default(() => Object.fromEntries(WEEKDAYS.map((name) => [name, []])))
  .superRefine((week, ctx) => {
    WEEKDAYS.forEach((name, i) => {
      const previous = week[WEEKDAYS[(i + WEEKDAYS.length - 1) % WEEKDAYS.length]];
      if (overlaps([...spillSpans(previous), ...ownSpans(week[name])])) {
        ctx.addIssue({ code: "custom", path: [name], message: "Opening times overlap" });
      }
    });
  });

const required = (message) => z.string({ error: message }).trim().min(1, message);

// null means "use the legal address".
const address = z
  .object({
    street: required("Street is required"),
    zip: z
      .string({ error: "Postcode is required" })
      .trim()
      .regex(/^\d{5}$/, "Postcode must be 5 digits"),
    city: required("City is required"),
  })
  .nullish()
  .transform((value) => value ?? null);

export const profileSchema = z.object({
  // The logo's folder is checked against the restaurant in profile.js.
  logoUrl: z
    .string()
    .trim()
    .url("Logo must be a link")
    .startsWith("https://", "Logo link must start with https://")
    .nullish()
    .transform((value) => value ?? null),
  address,
  openingHours,
});
