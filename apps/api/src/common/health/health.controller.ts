import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller()
export class HealthController {
  @Get('health/live')
  @Public()
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  ready() {
    return { status: 'ok' };
  }
}
