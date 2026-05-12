type MonthOptionsParams = {
  offset?: number;
  count?: number;
  baseDate?: Date;
};

export function formatMonth(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

export function getMonthOptions(params: MonthOptionsParams = {}): string[] {
  const { offset = 1, count = 3, baseDate = new Date() } = params;
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1);
  const months: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    months.push(formatMonth(date));
  }

  return months;
}
