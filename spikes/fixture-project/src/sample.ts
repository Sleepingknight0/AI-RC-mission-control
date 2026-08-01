export interface TelemetrySample {
  readonly timestamp: string;
  readonly value: number;
}

export function average(samples: readonly TelemetrySample[]): number {
  if (samples.length === 0) {
    return 0;
  }

  return samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
}
