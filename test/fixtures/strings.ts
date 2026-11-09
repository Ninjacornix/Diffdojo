export function countVowels(s: string): number {
  let n = 0;
  for (const ch of s) {
    if ("aeiou".includes(ch)) n++;
  }
  return n;
}

export const sumEven = (xs: number[]): number => {
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] % 2 === 0) total += xs[i];
  }
  return total;
};
