import { Injectable } from '@nestjs/common';
import { AkademikClient } from './akademik.types';

@Injectable()
export class MockAkademikClient implements AkademikClient {
  async cekStatus(nim: string): Promise<boolean> {
    return (process.env.AKADEMIK_MOCK_ACTIVE_NIMS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(nim);
  }
}
