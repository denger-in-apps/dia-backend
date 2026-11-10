import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ESKALASI_QUEUE, JOB_ESKALASI_SOS } from './eskalasi.constants';
import { EskalasiService } from './eskalasi.service';
import { LogThrottle } from './log-throttle';

/** Worker timer eskalasi. Job gagal (mis. DB sementara down) diulang dengan backoff eksponensial. */
@Processor(ESKALASI_QUEUE)
export class EskalasiProcessor extends WorkerHost {
  private readonly logger = new Logger(EskalasiProcessor.name);
  private readonly throttled = new LogThrottle(this.logger);

  constructor(private readonly eskalasi: EskalasiService) {
    super();
  }

  async process(job: Job<{ id_sos: string }>): Promise<{ dieskalasi: boolean }> {
    if (job.name !== JOB_ESKALASI_SOS) return { dieskalasi: false };
    return { dieskalasi: await this.eskalasi.eskalasi(job.data.id_sos, 'TIMER') };
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.throttled.warn(`Worker eskalasi: ${error.message}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(`Job eskalasi ${job?.id ?? '?'} gagal (percobaan ${job?.attemptsMade ?? '?'}): ${error.message}`);
  }
}
