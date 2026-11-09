// A date as an ISO string, or null when it is missing or not a valid date.
export const toIso = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};
