/**
 * Scheduler — manages CronJob lifecycle with setTimeout chaining.
 * Each job runs independently with its own timer and skip-on-busy guard.
 */

import type { CronJob, CronContext } from './job';

interface JobState {
  job: CronJob;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
}

export class Scheduler {
  private jobs = new Map<string, JobState>();
  private ctx: CronContext | null = null;

  /** Register a job (call before startAll) */
  register(job: CronJob): void {
    this.jobs.set(job.id, { job, timer: null, running: false, stopped: false });
  }

  /** Start all registered jobs */
  async startAll(ctx: CronContext): Promise<void> {
    this.ctx = ctx;

    for (const [id, state] of this.jobs) {
      try {
        if (state.job.setup) {
          await state.job.setup(ctx);
        }
        ctx.log.info({ jobId: id }, `Job ${state.job.name} initialized`);
      } catch (err) {
        ctx.log.error({ err, jobId: id }, `Job ${state.job.name} setup failed`);
      }

      // Start the loop
      this.scheduleNext(id);
    }
  }

  /** Stop all jobs gracefully — waits for running jobs to finish */
  async stopAll(): Promise<void> {
    const teardowns: Promise<void>[] = [];

    for (const [id, state] of this.jobs) {
      state.stopped = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      // Wait for running jobs
      if (state.running) {
        teardowns.push(
          new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (!state.running) {
                clearInterval(check);
                resolve();
              }
            }, 100);
            // Force resolve after 10s
            setTimeout(() => { clearInterval(check); resolve(); }, 10_000);
          })
        );
      }

      if (state.job.teardown) {
        teardowns.push(state.job.teardown().catch((err) => {
          this.ctx?.log.error({ err, jobId: id }, `Job teardown failed`);
        }));
      }
    }

    await Promise.all(teardowns);
  }

  /** Trigger a specific job immediately (outside schedule) */
  async trigger(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state || !this.ctx) return;

    if (state.running) {
      this.ctx.log.debug({ jobId }, 'Job already running, skipping trigger');
      return;
    }

    await this.runJob(state);
  }

  private scheduleNext(id: string): void {
    const state = this.jobs.get(id);
    if (!state || state.stopped || !this.ctx) return;

    const interval = this.ctx.defaults.get<number>(
      state.job.intervalKey,
      state.job.defaultInterval
    );

    state.timer = setTimeout(async () => {
      if (state.stopped) return;
      await this.runJob(state);
      this.scheduleNext(id);
    }, interval);
  }

  private async runJob(state: JobState): Promise<void> {
    if (!this.ctx || state.running) return;

    state.running = true;
    const start = Date.now();

    try {
      await state.job.run(this.ctx);
      const elapsed = Date.now() - start;
      this.ctx.log.debug({ jobId: state.job.id, elapsed }, `Job ${state.job.name} completed`);
    } catch (err) {
      this.ctx.log.error({ err, jobId: state.job.id }, `Job ${state.job.name} failed`);
    } finally {
      state.running = false;
    }
  }
}
