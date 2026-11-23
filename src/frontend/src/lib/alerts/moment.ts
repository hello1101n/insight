const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function momentParts(
  value: unknown
): { day: string; time: string } | undefined {
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || !/T|\s/.test(value)) return undefined;

  return {
    day: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
  };
}

export function momentText(day: string, time: string): string {
  return `${day}T${time}:00Z`;
}

// INVARIANT: the date picker works in local dates, so a UTC day is handed to
// it as local midnight of the same calendar day and read back by its local
// fields; the day never shifts with the viewer's time zone.
export function pickerDate(day: string): Date | undefined {
  const read = DAY.exec(day);
  if (!read) return undefined;

  return new Date(Number(read[1]), Number(read[2]) - 1, Number(read[3]));
}

export function pickedDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isTime(text: string): boolean {
  const read = TIME.exec(text);
  return read !== null && Number(read[1]) < 24 && Number(read[2]) < 60;
}
