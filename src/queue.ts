import { Queue, Worker } from 'bullmq';

import { redis } from './redis';
import { expireAccruals } from './services/bonus.service';

const queueConnection = redis.duplicate();

export const bonusQueue = new Queue('bonusQueue', {
  connection: queueConnection as any,
});

let expireAccrualsWorker: Worker | null = null;

export function startExpireAccrualsWorker(): Worker {
  if (expireAccrualsWorker) {
    return expireAccrualsWorker;
  }

  expireAccrualsWorker = new Worker(
    'bonusQueue',
    async (job) => {
      if (job.name === 'expireAccruals') {
        console.log(`[worker] expireAccruals started, jobId=${job.id}`);

        try {
          const expiredCount = await expireAccruals();
          console.log(`[worker] expired ${expiredCount} accruals`);
          return { expiredCount };
        } catch (error) {
          console.error(
            `[worker] expireAccruals failed:`,
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
      }
    },
    {
      connection: redis.duplicate() as any,
      autorun: true,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          // Exponential backoff: 1s, 2s, 4s
          return Math.min(1000 * Math.pow(2, attemptsMade - 1), 10000);
        },
      },
    },
  );

  expireAccrualsWorker.on('completed', (job) => {
    console.log(`[worker] completed, jobId=${job.id}`);
  });

  expireAccrualsWorker.on('failed', (job, err) => {
    console.error(`[worker] failed, jobId=${job?.id}, attempts=${job?.attemptsMade}`, err);
  });

  return expireAccrualsWorker;
}
