export function getLossLimitStopReason(
  dailyLossPct: number,
  weeklyLossPct: number,
  maxDaily = 5,
  maxWeekly = 12,
): string | null {
  if (Number.isFinite(maxDaily) && maxDaily > 0 && dailyLossPct <= -maxDaily) {
    return `Дневной лимит убытка достигнут: ${dailyLossPct.toFixed(1)}% (лимит ${maxDaily}%)`;
  }
  if (Number.isFinite(maxWeekly) && maxWeekly > 0 && weeklyLossPct <= -maxWeekly) {
    return `Недельный лимит убытка достигнут: ${weeklyLossPct.toFixed(1)}% (лимит ${maxWeekly}%)`;
  }
  return null;
}