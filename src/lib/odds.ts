/**
 * Convert decimal odds (e.g. 2.10) to UK fractional format (e.g. "11/10")
 * 
 * decimal odds = (numerator / denominator) + 1
 * So fractional odds = decimal - 1
 * e.g. 2.10 → 1.10 → 11/10
 */
export function decimalToFractional(odds: number): string {
  if (odds <= 1) return "1/1";
  
  const fraction = odds - 1;
  
  // Handle common fractional odds with predefined precision
  const pct = Math.round(fraction * 100);
  
  // Map of common fractional odds by percentage points (rounded)
  const common: Record<number, string> = {
    1: "1/100", 2: "1/50", 3: "1/33", 4: "1/25", 5: "1/20",
    6: "1/16", 7: "1/14", 8: "2/25", 9: "1/11", 10: "1/10",
    11: "1/9", 12: "2/17", 13: "1/8", 14: "2/15", 15: "3/20",
    16: "4/25", 17: "1/6", 18: "2/11", 19: "1/5", 20: "1/5",
    22: "2/9", 25: "1/4", 27: "1/4", 29: "2/7", 30: "3/10",
    33: "1/3", 36: "4/11", 40: "2/5", 44: "4/9", 50: "1/2",
    53: "8/15", 57: "4/7", 60: "3/5", 62: "5/8", 67: "2/3",
    70: "7/10", 73: "11/15", 75: "3/4", 80: "4/5", 83: "5/6",
    85: "5/6", 88: "7/8", 90: "9/10", 91: "10/11", 95: "20/21",
    100: "1/1",
    110: "11/10", 111: "10/9", 114: "8/7", 117: "7/6", 120: "6/5",
    125: "5/4", 130: "13/10", 133: "4/3", 135: "27/20", 140: "7/5",
    143: "10/7", 150: "6/4", 150: "3/2", 160: "8/5", 167: "5/3",
    175: "7/4", 180: "9/5", 182: "11/6", 190: "19/10", 200: "2/1",
    210: "21/10", 220: "11/5", 225: "9/4", 240: "12/5", 250: "5/2",
    260: "13/5", 275: "11/4", 280: "14/5", 300: "3/1", 325: "13/4",
    333: "10/3", 350: "7/2", 375: "15/4", 400: "4/1", 450: "9/2",
    500: "5/1",
  };

  // Try exact match first, then find closest
  if (common[pct]) return common[pct];
  
  // Find closest match
  const keys = Object.keys(common).map(Number).sort((a, b) => a - b);
  let closest = keys[0];
  for (const k of keys) {
    if (Math.abs(k - pct) < Math.abs(closest - pct)) {
      closest = k;
    }
  }
  // If close enough, use the mapped value
  if (Math.abs(closest - pct) <= 5) {
    return common[closest];
  }

  // Fallback: simplify the fraction manually
  const num = Math.round(fraction * 100);
  const den = 100;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

/**
 * Format a value to display as fractional odds string
 */
export function formatOdds(odds: number): string {
  return decimalToFractional(odds);
}