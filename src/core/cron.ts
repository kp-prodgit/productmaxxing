type Test = (n: number) => boolean;

/** One cron field ("*", "5", "8-18", "12,17", "1-5") as a test. */
const cronField = (f: string): Test => (n) =>
  f === "*" || f.split(",").some((part) => {
    const [a = NaN, b = a] = part.split("-").map(Number);
    return n >= a && n <= b;
  });

/** The first time a five-field cron expression fires after `from`, in this Mac's local time, looking 8 days ahead. */
export function nextCronTime(cron: string, from: Date): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, h, dom, mon, dow] = fields.map(cronField) as [Test, Test, Test, Test, Test];
  const t = new Date(from);
  t.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (mi(t.getMinutes()) && h(t.getHours()) && dom(t.getDate()) && mon(t.getMonth() + 1) && dow(t.getDay())) return t;
  }
  return null;
}
