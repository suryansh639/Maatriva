/** Round to 2 decimal places (0.01 grid). Explicit so parser, encoder and UI agree. */
export const round2 = (x: number): number => Math.round(x * 100) / 100;
