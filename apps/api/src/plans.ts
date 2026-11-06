// What each plan allows one job, and what worker time costs (millicredits per second).
import type { JobLimits } from "@neuracraft/shared";

export interface Plan {
  limits: JobLimits;
  concurrentJobs: number;
  priority: number;
}

export const plans: Record<string, Plan> = {
  free: {
    limits: { maxSteps: 12, maxPixels: 1024 * 1024, maxFrames: 48, maxDenoiseSteps: 30, maxSeconds: 300 },
    concurrentJobs: 1,
    priority: 0,
  },
  pro: {
    limits: { maxSteps: 40, maxPixels: 2048 * 2048, maxFrames: 240, maxDenoiseSteps: 60, maxSeconds: 1800 },
    concurrentJobs: 4,
    priority: 10,
  },
};

export const planFor = (name: string): Plan => plans[name] ?? plans.free!;

// 1 credit = 1000 millicredits; a CPU worker minute costs 1 credit, a GPU minute 10 (to be tuned).
export const ratePerSecond: Record<string, number> = { cpu: 1000 / 60, gpu: 10000 / 60 };
export const cost = (workerClass: string, seconds: number) => Math.ceil((ratePerSecond[workerClass] ?? ratePerSecond.cpu!) * seconds);
