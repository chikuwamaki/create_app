type MonthOptions = {
  past?: number;
  future?: number;
  baseDate?: Date;
};

export function buildMonthOptions(options: MonthOptions = {}): string[] {
  const { past = 12, future = 3, baseDate = new Date() } = options;
  const months: string[] = [];
  const base = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1));
  const startOffset = -(past - 1);
  for (let offset = startOffset; offset <= future; offset += 1) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
    months.push(`${year}-${month}`);
  }
  return months;
}

export function formatMonth(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

export function defaultOperationalMonth(baseDate = new Date()): string {
  return formatMonth(
    new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1)
  );
}

export function monthOptions(options: MonthOptions = {}) {
  return buildMonthOptions(options).map((value) => ({
    value,
    label: value
  }));
}
